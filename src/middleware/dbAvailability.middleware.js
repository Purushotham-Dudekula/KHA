const mongoose = require("mongoose");

function isHealthPath(pathname) {
  return pathname === "/api/health" || pathname === "/api/v1/health";
}

/**
 * Rejects non-health requests when MongoDB is disconnected.
 * Keeps health endpoints reachable for diagnostics.
 */
function requireDbConnection() {
  return (req, res, next) => {
    const path = String(req.path || req.originalUrl || "");
    if (isHealthPath(path)) return next();

    // 1 connected, 2 connecting. Both are safe to serve requests.
    const state = mongoose.connection?.readyState;
    if (state === 1 || state === 2) return next();

    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  };
}

module.exports = { requireDbConnection };
