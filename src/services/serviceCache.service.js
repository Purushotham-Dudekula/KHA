const Service = require("../models/service.model");

let cache = null;
let cacheByCode = null;

async function refreshServiceCache() {
  const services = await Service.find({}).lean();
  cache = services;
  cacheByCode = new Map(services.map((s) => [String(s.code || "").trim().toLowerCase(), s]));
  return services;
}

function invalidateServiceCache() {
  cache = null;
  cacheByCode = null;
}

async function getAllServicesCached() {
  if (!cache) {
    await refreshServiceCache();
  }
  return cache || [];
}

async function getServiceByCodeCached(code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!cacheByCode) {
    await refreshServiceCache();
  }
  return cacheByCode.get(normalized) || null;
}

module.exports = {
  refreshServiceCache,
  invalidateServiceCache,
  getAllServicesCached,
  getServiceByCodeCached,
};
