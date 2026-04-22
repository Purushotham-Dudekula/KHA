const Pricing = require("../models/pricing.model");
const { getOrSetCachedJson } = require("./cache.service");

async function getPricingByServiceTypeCached(serviceTypeNormalized, ttlSeconds = 300) {
  const st = String(serviceTypeNormalized || "").trim().toLowerCase();
  if (!st) return null;
  return getOrSetCachedJson(`pricing:${st}`, ttlSeconds, async () => {
    const doc = await Pricing.findOne({ serviceType: st }).lean();
    return doc || null;
  });
}

module.exports = {
  getPricingByServiceTypeCached,
};

