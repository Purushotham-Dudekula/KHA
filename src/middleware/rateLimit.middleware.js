const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedisClient } = require("../services/redis.service");
const { logger } = require("../utils/logger");

function hasBearerToken(req) {
  const header = req.headers?.authorization;
  return typeof header === "string" && header.startsWith("Bearer ");
}

function buildLimiter({ windowMs, maxAuthenticated, maxUnauthenticated, message }) {
  const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const redis = getRedisClient();
  let store;
  if (redis) {
    try {
      store = new RedisStore({
        sendCommand: (...args) => redis.call(...args),
      });
    } catch (error) {
      logger.error("Redis rate limit store initialization failed", {
        message: error?.message || String(error),
      });
      if (isProduction) {
        throw new Error("Redis rate limiter initialization failed in production.");
      }
      // Non-production fallback to in-memory store.
      store = undefined;
    }
  } else if (isProduction) {
    throw new Error("Redis client unavailable for rate limiting in production.");
  }

  return rateLimit({
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
    max: (req) => (hasBearerToken(req) ? maxAuthenticated : maxUnauthenticated),
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message,
      });
    },
  });
}

const globalApiLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  maxAuthenticated: 300,
  maxUnauthenticated: 120,
  message: "Too many requests from this IP, please try again later.",
});

module.exports = {
  globalApiLimiter,
  buildLimiter,
};
