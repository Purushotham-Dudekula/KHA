let redisClient = null;
let redisHealthy = false;
const { logger } = require("../utils/logger");

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function isTest() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function isRedisDisabled() {
  return String(process.env.REDIS_DISABLED || "")
    .trim()
    .toLowerCase() === "true";
}

function getRedisClient() {
  if (isTest() || isRedisDisabled()) return null;
  if (redisClient) return redisClient;
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) return null;
  try {
    const Redis = require("ioredis");
    redisClient = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redisClient.on("ready", () => {
      redisHealthy = true;
    });
    redisClient.on("end", () => {
      redisHealthy = false;
    });
    redisClient.on("error", () => {
      redisHealthy = false;
    });
    return redisClient;
  } catch {
    logger.warn("Redis client initialization failed; falling back to non-Redis mode");
    return null;
  }
}

async function connectRedisOrThrow() {
  if (isTest() || isRedisDisabled()) {
    redisHealthy = false;
    return null;
  }
  const client = getRedisClient();
  if (!client) {
    if (isProduction()) {
      throw new Error("REDIS_URL is required in production.");
    }
    return null;
  }

  try {
    if (client.status !== "ready") {
      await client.connect();
    }
  } catch (e) {
    redisHealthy = false;
    logger.warn("Redis connect failed; using fallback logic where available", {
      message: e?.message || String(e),
    });
    if (isProduction()) {
      throw new Error(`Redis connection failed in production: ${e?.message || String(e)}`);
    }
    return null;
  }

  try {
    const pong = await client.ping();
    redisHealthy = pong === "PONG";
    if (!redisHealthy && isProduction()) {
      throw new Error("Redis ping failed in production.");
    }
  } catch (e) {
    redisHealthy = false;
    logger.warn("Redis ping failed; using fallback logic where available", {
      message: e?.message || String(e),
    });
    if (isProduction()) {
      throw new Error(`Redis ping failed in production: ${e?.message || String(e)}`);
    }
    return null;
  }

  return client;
}

function getRedisHealth() {
  const disabled = isTest() || isRedisDisabled();
  return {
    configured: !disabled && Boolean(String(process.env.REDIS_URL || "").trim()),
    connected: !disabled && redisHealthy,
  };
}

async function closeRedis() {
  if (!redisClient) return;
  try {
    await redisClient.quit();
  } catch {
    try {
      redisClient.disconnect();
    } catch {
      // ignore
    }
  } finally {
    redisHealthy = false;
    redisClient = null;
  }
}

async function createSocketIoRedisClients() {
  if (isTest() || isRedisDisabled()) return null;
  const base = getRedisClient();
  if (!base) return null;
  try {
    const pubClient = base;
    const subClient = base.duplicate();
    if (pubClient.status !== "ready") {
      await pubClient.connect();
    }
    if (subClient.status !== "ready") {
      await subClient.connect();
    }
    return { pubClient, subClient };
  } catch {
    return null;
  }
}

module.exports = {
  getRedisClient,
  connectRedisOrThrow,
  getRedisHealth,
  closeRedis,
  createSocketIoRedisClients,
};
