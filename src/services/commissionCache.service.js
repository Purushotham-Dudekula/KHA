const Commission = require("../models/commission.model");
const { getOrSetCachedJson } = require("./cache.service");

async function getActiveCommissionCached(ttlSeconds = 300) {
  return getOrSetCachedJson("commission:active", ttlSeconds, async () => {
    const doc = await Commission.findOne({ active: true }).sort({ updatedAt: -1 }).lean();
    return doc || null;
  });
}

module.exports = {
  getActiveCommissionCached,
};

