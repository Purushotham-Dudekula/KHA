const IORedis = require("ioredis");

function getRedisUrl() {
  return String(process.env.REDIS_URL || "").trim();
}

function createBullConnection() {
  const url = getRedisUrl();
  if (!url) return null;
  // BullMQ expects an ioredis instance.
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

module.exports = { createBullConnection };

