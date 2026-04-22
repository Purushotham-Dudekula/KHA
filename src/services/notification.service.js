const mongoose = require("mongoose");
const Notification = require("../models/notification.model");
const NotificationRetry = require("../models/notificationRetry.model");
const User = require("../models/user.model");
const { sendPushNotification } = require("./fcm.service");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { enqueueNotificationRetryJob, startNotificationWorker } = require("../queues/notification.queue");

const NOTIFICATION_RETRY_MAX_ATTEMPTS = 3;
const NOTIFICATION_RETRY_DELAY_MS = 60 * 1000;
const NOTIFICATION_RETRY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_RETRY_RETENTION_DAYS = Math.min(
  30,
  Math.max(7, Number(process.env.NOTIFICATION_RETRY_RETENTION_DAYS || 14))
);
let retryWorkerStarted = false;
let queueWorkerStarted = false;

function resolveIo(req, app) {
  const application = req?.app || app;
  return application?.get?.("io") || null;
}

async function queueNotificationRetry({ userId, title, message, type, bookingId, fcmToken, error }) {
  try {
    await NotificationRetry.create({
      userId,
      title,
      message,
      type,
      bookingId: bookingId || null,
      fcmToken: String(fcmToken || "").trim(),
      attempts: 0,
      maxAttempts: NOTIFICATION_RETRY_MAX_ATTEMPTS,
      nextRetryAt: new Date(Date.now() + NOTIFICATION_RETRY_DELAY_MS),
      status: "pending",
      lastError: error ? String(error.message || error) : "",
    });

    // Best-effort: schedule a queue job (if available) to process retries sooner than the timer tick.
    try {
      await enqueueNotificationRetryJob({ trigger: "new_retry_record" });
    } catch {
      // ignore
    }
  } catch (queueErr) {
    logger.error("Notification retry queue persist failed (non-blocking)", {
      message: queueErr?.message,
      userId: String(userId),
    });
  }
}

async function processNotificationRetryBatch() {
  const now = new Date();
  const items = await NotificationRetry.find({
    status: "pending",
    nextRetryAt: { $lte: now },
    attempts: { $lt: NOTIFICATION_RETRY_MAX_ATTEMPTS },
  })
    .sort({ nextRetryAt: 1 })
    .limit(50)
    .lean();

  for (const item of items) {
    try {
      const token = String(item.fcmToken || "").trim();
      if (!token) {
        await NotificationRetry.updateOne(
          { _id: item._id },
          { $set: { status: "failed", lastError: "Missing fcm token", attempts: item.attempts + 1 } }
        );
        continue;
      }

      await sendPushNotification({
        token,
        title: item.title,
        body: item.message,
        data: {
          bookingId: item.bookingId ? String(item.bookingId) : "",
          type: item.type || "alert",
        },
      });

      await NotificationRetry.updateOne(
        { _id: item._id },
        { $set: { status: "delivered", lastError: "" }, $inc: { attempts: 1 } }
      );
    } catch (err) {
      const nextAttempts = Number(item.attempts || 0) + 1;
      const exhausted = nextAttempts >= Number(item.maxAttempts || NOTIFICATION_RETRY_MAX_ATTEMPTS);
      await NotificationRetry.updateOne(
        { _id: item._id },
        {
          $set: {
            status: exhausted ? "failed" : "pending",
            lastError: String(err?.message || err),
            nextRetryAt: new Date(Date.now() + NOTIFICATION_RETRY_DELAY_MS),
          },
          $inc: { attempts: 1 },
        }
      );
    }
  }
}

async function processNotificationRetryJob(_data) {
  // Reuse the same logic as the existing batch worker; one job processes a batch.
  await processNotificationRetryBatch();
}

async function cleanupNotificationRetryRecords() {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await NotificationRetry.deleteMany({
    status: { $in: ["delivered", "failed"] },
    updatedAt: { $lt: cutoff },
  });
  if (Number(result?.deletedCount || 0) > 0) {
    logger.info("Notification retry cleanup completed", {
      deletedCount: Number(result.deletedCount || 0),
      retentionDays: NOTIFICATION_RETRY_RETENTION_DAYS,
    });
  }
}

function ensureRetryWorkerStarted() {
  if (retryWorkerStarted) return;
  retryWorkerStarted = true;

  // Prefer BullMQ worker when available; fall back to legacy timers.
  if (!queueWorkerStarted) {
    const worker = startNotificationWorker(processNotificationRetryJob);
    if (worker) {
      queueWorkerStarted = true;
      logger.info("[notification] retry worker running on queue");
      return;
    }
  }

  // Jest sets JEST_WORKER_ID; integration tests often use NODE_ENV=development then disconnect Mongo.
  // Long-lived timers would fire after teardown and hold the event loop open (or error against a closed DB).
  if (process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  const retryTimer = setInterval(() => {
    processNotificationRetryBatch().catch((err) => {
      logger.warn("Notification retry worker iteration failed", { message: err?.message });
    });
  }, NOTIFICATION_RETRY_DELAY_MS);
  if (typeof retryTimer.unref === "function") retryTimer.unref();

  const cleanupTimer = setInterval(() => {
    cleanupNotificationRetryRecords().catch((err) => {
      logger.warn("Notification retry cleanup iteration failed", { message: err?.message });
    });
  }, NOTIFICATION_RETRY_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
}

/**
 * Persist notification and emit on Socket.IO room user:<userId>.
 * Failures in persistence or socket emit never throw — main business flows stay unaffected.
 *
 * @param {string|undefined} [fcmTokenPreloaded] When set (including ""), skip User DB read for FCM; used by batched broadcasts.
 */
async function notifyUser({ req, app, userId, message, type, title, bookingId, fcmTokenPreloaded }) {
  if (!env.enableNotifications) {
    logger.info("[NOTIFICATIONS_SKIPPED] notifyUser skipped (notifications disabled)", {
      tag: "NOTIFICATIONS_SKIPPED",
      operation: "notifyUser",
      userId: userId != null ? String(userId) : null,
      bookingId: bookingId != null ? String(bookingId) : null,
    });
    return null;
  }
  ensureRetryWorkerStarted();
  const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId));

  const category = (() => {
    if (!type) return "booking";
    if (["booking", "payment", "job", "alert"].includes(type)) return type;
    const t = String(type);
    if (["advance_paid", "payment_pending"].includes(t)) return "payment";
    if (["job_reminder", "job_started", "job_completed"].includes(t)) return "job";
    return "booking";
  })();

  const resolvedTitle = typeof title === "string" && title.trim() ? title.trim() : (() => {
    if (category === "alert") return "Alert";
    if (category === "payment") return "Payment update";
    if (category === "job") return "Job update";
    return "Booking update";
  })();

  const payload = {
    userId: uid,
    title: resolvedTitle,
    message,
    type: category,
    isRead: false,
  };
  let bid;
  if (bookingId != null) {
    bid =
      bookingId instanceof mongoose.Types.ObjectId
        ? bookingId
        : new mongoose.Types.ObjectId(String(bookingId));
    payload.bookingId = bid;
  }

  let doc = null;
  try {
    doc = await Notification.create(payload);
  } catch (error) {
    logger.error("Notification.create failed (non-blocking)", {
      message: error?.message,
      userId: uid.toString(),
    });
  }

  const io = resolveIo(req, app);
  if (io && doc) {
    try {
      io.to(`user:${uid.toString()}`).emit("notification", {
        id: doc._id,
        message,
        type: category,
        title: resolvedTitle,
        bookingId: bid ? bid.toString() : null,
        isRead: false,
      });
    } catch (error) {
      logger.error("Socket.IO notification emit failed (non-blocking)", {
        message: error?.message,
        userId: uid.toString(),
      });
    }
  }

  let resolvedFcmToken = "";
  try {
    let rawToken = "";
    if (fcmTokenPreloaded !== undefined) {
      rawToken = fcmTokenPreloaded != null ? String(fcmTokenPreloaded).trim() : "";
    } else {
      const user = await User.findById(uid).select("fcmToken").lean();
      rawToken = user?.fcmToken != null ? String(user.fcmToken).trim() : "";
    }
    resolvedFcmToken = rawToken;
    if (rawToken) {
      await sendPushNotification({
        token: rawToken,
        title: resolvedTitle,
        body: message,
        data: {
          bookingId: bid ? bid.toString() : "",
          type: category,
        },
      });
    }
  } catch (error) {
    logger.warn("FCM push failed (notification flow continues)", { message: error?.message });
    await queueNotificationRetry({
      userId: uid,
      title: resolvedTitle,
      message,
      type: category,
      bookingId: bid || null,
      fcmToken: resolvedFcmToken,
      error,
    });
  }

  return doc;
}

async function notifyUsers(app, req, items) {
  for (const item of items) {
    await notifyUser({ req, app, ...item });
  }
}

function notifyAdvanceReceived(req, operatorId, bookingId) {
  return notifyUser({
    req,
    app: null,
    userId: operatorId,
    message: "Advance received",
    type: "payment",
    title: "Advance received",
    bookingId,
  });
}

module.exports = {
  notifyUser,
  notifyUsers,
  notifyAdvanceReceived,
};
