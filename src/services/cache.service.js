const { getRedisClient } = require("./redis.service");

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function getCachedJson(key) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const v = await client.get(key);
    if (!v) return null;
    return safeJsonParse(v);
  } catch {
    return null;
  }
}

async function setCachedJson(key, value, ttlSeconds) {
  const client = getRedisClient();
  if (!client) return false;
  const ttl = Math.max(1, Math.min(86400, Number(ttlSeconds) || 0));
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttl);
    return true;
  } catch {
    return false;
  }
}

async function getOrSetCachedJson(key, ttlSeconds, loader) {
  const cached = await getCachedJson(key);
  if (cached !== null) return cached;
  const fresh = await loader();
  await setCachedJson(key, fresh, ttlSeconds);
  return fresh;
}

module.exports = {
  getCachedJson,
  setCachedJson,
  getOrSetCachedJson,
};

