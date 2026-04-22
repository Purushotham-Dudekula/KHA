const crypto = require("crypto");
const { getRedisClient } = require("./redis.service");
const { logger } = require("../utils/logger");
const inMemoryLocalLocks = new Map();

function randomToken() {
  return crypto.randomBytes(16).toString("hex");
}

function acquireInMemoryLock(key, ttlMs) {
  const now = Date.now();
  const existing = inMemoryLocalLocks.get(key);
  if (existing && existing.expiresAt > now) {
    return { acquired: false, token: null, skipped: false };
  }
  const token = randomToken();
  const ttl = Math.max(1000, Number(ttlMs) || 30000);
  inMemoryLocalLocks.set(key, { token, expiresAt: now + ttl });
  return { acquired: true, token, skipped: false };
}

function releaseInMemoryLock(key, token) {
  if (!token) return;
  const existing = inMemoryLocalLocks.get(key);
  if (existing && existing.token === String(token)) {
    inMemoryLocalLocks.delete(key);
  }
}

async function acquireLock(key, ttlMs) {
  const isTest = String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
  const normalizedKey = String(key);
  if (isTest) {
    return acquireInMemoryLock(normalizedKey, ttlMs);
  }
  const redis = getRedisClient();
  const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (!redis) {
    if (isProduction) {
      logger.error("Redis lock acquire skipped in production because redis client is unavailable", {
        key: normalizedKey,
      });
      return { acquired: false, token: null, skipped: true, error: "Lock acquisition failed" };
    }
    return acquireInMemoryLock(normalizedKey, ttlMs);
  }
  const token = randomToken();
  try {
    const ok = await redis.set(
      normalizedKey,
      token,
      "PX",
      Math.max(1000, Number(ttlMs) || 30000),
      "NX"
    );
    return { acquired: ok === "OK", token, skipped: false };
  } catch (error) {
    if (isProduction) {
      logger.error("Redis lock acquire failed in production", {
        key: normalizedKey,
        message: error?.message || String(error),
      });
      return { acquired: false, token: null, skipped: true, error: "Lock acquisition failed" };
    }
    logger.warn("Redis lock acquire failed; continuing without distributed lock (non-production)", {
      key: normalizedKey,
      message: error?.message || String(error),
    });
    return { acquired: true, token: null, skipped: true };
  }
}

async function releaseLock(key, token) {
  const isTest = String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
  const normalizedKey = String(key);
  if (isTest) {
    releaseInMemoryLock(normalizedKey, token);
    return;
  }
  const redis = getRedisClient();
  if (!redis) {
    releaseInMemoryLock(normalizedKey, token);
    return;
  }
  if (!token) return;
  // release only if token matches
  try {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      normalizedKey,
      String(token)
    );
  } catch (error) {
    logger.warn("Redis lock release failed; lock will expire via TTL", {
      key: normalizedKey,
      message: error?.message || String(error),
    });
  }
}

module.exports = { acquireLock, releaseLock };

