require("dotenv").config();

const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { createApp } = require("./src/app");
const { connectDB } = require("./src/config/db");
const { env, validateEnv, startupIntegrationStatus } = require("./src/config/env");
const { scheduleBookingReminders } = require("./src/jobs/bookingReminder.cron");
const { schedulePaymentReconciliation } = require("./src/jobs/paymentReconciliation.cron");
const { scheduleBookingPaymentLockExpiry } = require("./src/jobs/bookingPaymentLock.cron");
const { logger } = require("./src/utils/logger");
const { initFirebaseIfConfigured } = require("./src/services/fcm.service");
const {
  connectRedisOrThrow,
  closeRedis,
  createSocketIoRedisClients,
  getRedisClient,
} = require("./src/services/redis.service");
const { bullmqAvailable } = require("./src/services/queueHealth.service");
const User = require("./src/models/user.model");
const { startWebhookWorker } = require("./src/queues/webhook.queue");
const { startPaymentWorker } = require("./src/queues/payment.queue");
const { startNotificationWorker } = require("./src/queues/notification.queue");
const Notification = require("./src/models/notification.model");

let httpServerRef = null;
let ioRef = null;
let isShuttingDown = false;

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("Unhandled Rejection — initiating graceful shutdown", err);
  void gracefulShutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception", err);
  process.exit(1);
});

function shouldUseSocketIoRedisAdapter() {
  const raw = String(process.env.ENABLE_SOCKET_IO_REDIS || "").trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully`, { exitCode });

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 15000);

  try {
    if (ioRef) {
      await new Promise((resolve) => {
        ioRef.close(() => resolve());
      });
    }
    if (httpServerRef) {
      await new Promise((resolve, reject) => {
        httpServerRef.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
      });
    }
    await closeRedis();
    await mongoose.connection.close();
    logger.info("Graceful shutdown complete");
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (e) {
    logger.error("Error during graceful shutdown", e);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

async function start() {
  // Runtime safety: warn on older Node versions (do not block startup).
  try {
    const major = parseInt(String(process.versions?.node || "0").split(".")[0], 10);
    if (Number.isFinite(major) && major > 0 && major < 20) {
      logger.warn("Node.js runtime is below 20; upgrade required for consistency", {
        node: process.versions.node,
      });
    }
  } catch {
    // ignore
  }

  validateEnv();
  const integrationStatus = startupIntegrationStatus();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isProd = nodeEnv === "production";

  logger.info("Server starting", {
    nodeEnv: process.env.NODE_ENV || "development",
    port: env.port,
  });

  await connectDB(env.mongoUri);
  await connectRedisOrThrow();
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      const pong = await redisClient.ping();
      if (pong !== "PONG") {
        throw new Error("Redis ping did not return PONG");
      }
      logger.info("Redis connected successfully");
    }
  } catch (error) {
    if (isProd) {
      logger.error("Critical: Redis ping failed in production", {
        message: error?.message || String(error),
      });
      process.exit(1);
    }
    logger.warn("Redis ping failed in development, continuing without strict Redis dependency", {
      message: error?.message || String(error),
    });
  }
  logger.info("Startup readiness: MongoDB connected");
  if (integrationStatus.redis.disabled) {
    logger.warn("Startup readiness: Redis disabled via REDIS_DISABLED=true");
  } else if (integrationStatus.redis.configured) {
    logger.info("Startup readiness: Redis configured");
  } else {
    logger.warn(`Startup readiness: Redis not configured. ${integrationStatus.redis.warning}`);
  }
  if (integrationStatus.razorpay.configured) {
    logger.info("Startup readiness: Razorpay configured");
  } else {
    logger.warn(`Startup readiness: ${integrationStatus.razorpay.warning}`);
  }
  if (integrationStatus.smtp.configured) {
    logger.info("Startup readiness: SMTP configured");
  } else {
    logger.warn(`Startup readiness: ${integrationStatus.smtp.warning}`);
  }
  if (integrationStatus.otpSms.configured) {
    logger.info("Startup readiness: OTP SMS configured");
  } else {
    logger.warn(`Startup readiness: ${integrationStatus.otpSms.warning}`);
  }
  if (integrationStatus.storage.configured) {
    logger.info("Startup readiness: storage configured");
  } else {
    logger.warn(`Startup readiness: ${integrationStatus.storage.warning}`);
  }
  if (!integrationStatus.cors.configured) {
    logger.warn(`Startup readiness: ${integrationStatus.cors.warning}`);
  }
  if (isProd && !bullmqAvailable()) {
    throw new Error("BullMQ is required in production (dependency missing).");
  }
  initFirebaseIfConfigured();

  const app = createApp();
  logger.info("API routes mounted at /api/v1 (health remains at /api/health)");
  const httpServer = http.createServer(app);
  httpServer.timeout = 120000;
  httpServerRef = httpServer;
  const socketOrigins = env.corsOrigins && env.corsOrigins.length > 0 ? env.corsOrigins : false;
  const io = new Server(httpServer, {
    cors: {
      origin: socketOrigins,
      credentials: true,
    },
  });

  if (shouldUseSocketIoRedisAdapter()) {
    try {
      const clients = await createSocketIoRedisClients();
      if (clients) {
        const { createAdapter } = require("@socket.io/redis-adapter");
        io.adapter(createAdapter(clients.pubClient, clients.subClient));
        logger.info("Socket.IO Redis adapter enabled");
      } else {
        logger.warn("Socket.IO Redis adapter disabled (Redis clients unavailable)");
      }
    } catch (error) {
      logger.warn("Socket.IO Redis adapter initialization failed", {
        message: error?.message || String(error),
      });
    }
  }

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const header = socket.handshake.headers?.authorization;
      const token =
        (typeof auth.token === "string" && auth.token) ||
        (typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null);

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.scope === "admin") {
        return next(new Error("Invalid token"));
      }
      if (!decoded.id) {
        return next(new Error("Invalid token"));
      }

      // Harden sockets: ensure user exists and isn't blocked.
      const uid = String(decoded.id);
      if (!mongoose.Types.ObjectId.isValid(uid)) {
        return next(new Error("Invalid token"));
      }
      const user = await User.findById(uid).select("isBlocked").lean();
      if (!user || user.isBlocked === true) {
        return next(new Error("Authentication failed"));
      }

      socket.data.userId = uid;
      return next();
    } catch (err) {
      if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
        return next(new Error("Authentication failed"));
      }
      return next(err);
    }
  });

  app.set("io", io);
  ioRef = io;

  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });

  scheduleBookingReminders(app);
  scheduleBookingPaymentLockExpiry();
  schedulePaymentReconciliation();
  const webhookW = startWebhookWorker();
  const payW = startPaymentWorker();
  const notifW = startNotificationWorker();
  if (isProd && (!webhookW || !payW || !notifW)) {
    throw new Error("Queue workers must be running in production.");
  }
  // Workers are expected to be running; in non-prod we allow degraded mode.

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    logger.info(`Socket connected: ${socket.id}`, { userId: String(userId) });

    const emitUnreadNotifications = async () => {
      try {
        const unread = await Notification.find({ userId, isRead: false })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();
        socket.emit("notifications:unread", {
          count: unread.length,
          notifications: unread,
        });
      } catch (error) {
        logger.warn("Failed to load unread notifications on socket connect", {
          userId: String(userId),
          message: error?.message || String(error),
        });
      }
    };

    void emitUnreadNotifications();

    socket.on("subscribe_user", (requestedUserId) => {
      // TODO: Remove in Sprint 2 / v2.0 release
      logger.warn("[DEPRECATED] subscribe_user event will be removed in v2. Use subscribe instead.", { socketId: socket.id });
      if (
        typeof requestedUserId === "string" &&
        mongoose.Types.ObjectId.isValid(requestedUserId) &&
        String(requestedUserId) === String(userId)
      ) {
        socket.join(`user:${userId}`);
        void emitUnreadNotifications();
      }
    });

    socket.on("notifications:fetch-unread", () => {
      void emitUnreadNotifications();
    });

    socket.on("disconnect", () => {
      logger.info(`Socket disconnected: ${socket.id}`, { userId: String(userId) });
    });
  });

  httpServer.listen(env.port, () => {
    logger.info("HTTP server listening", { port: env.port });
  });
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err?.message || String(err)}`);
  process.exit(1);
});

