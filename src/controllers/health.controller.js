const mongoose = require("mongoose");
const { getRedisHealth } = require("../services/redis.service");
const { sendSuccess } = require("../utils/response");

function getDbStatus() {
  // Mongoose readyState: 1 connected, 2 connecting.
  const state = mongoose.connection?.readyState;
  if (state === 1) return "connected";
  if (state === 2) return "connecting";
  return "disconnected";
}

function getHealth(_req, res) {
  const redis = getRedisHealth();
  const dbStatus = getDbStatus();
  const redisStatus = redis.connected ? "connected" : redis.configured ? "connecting" : "disconnected";

  // Keep existing compatibility fields while adding production health shape.
  return sendSuccess(
    res,
    {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dbStatus,
      redisStatus,
      redis,
    },
    "Health fetched."
  );
}

module.exports = { getHealth };
