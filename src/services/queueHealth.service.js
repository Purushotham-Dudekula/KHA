const { getRedisHealth } = require("./redis.service");

function bullmqAvailable() {
  try {
    require("bullmq");
    return true;
  } catch {
    return false;
  }
}

function getQueueHealth() {
  const redis = getRedisHealth();
  return {
    bullmqAvailable: bullmqAvailable(),
    redisConfigured: Boolean(redis.configured),
    redisConnected: Boolean(redis.connected),
  };
}

module.exports = { getQueueHealth, bullmqAvailable };

