const mongoose = require("mongoose");

function isHealthPath(pathname) {
  return pathname === "/api/health" || pathname === "/api/v1/health";
}

function mongoConnectionSafety() {
  return (req, res, next) => {
    const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
    if (nodeEnv !== "production") {
      return next();
    }

    const path = String(req.path || req.originalUrl || "");
    if (isHealthPath(path)) return next();

    const readyState = mongoose.connection?.readyState;
    if (readyState === 1 || readyState === 2) {
      return next();
    }

    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  };
}

module.exports = { mongoConnectionSafety };
