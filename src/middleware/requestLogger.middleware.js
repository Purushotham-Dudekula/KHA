const { randomUUID } = require("crypto");
const { logger } = require("../utils/logger");

/**
 * Assigns req.requestId, logs each request on response finish (method, URL, status, duration).
 */
function requestLogger(req, res, next) {
  if (!req.requestId) {
    req.requestId = randomUUID();
  }
  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const userId =
      req.user && req.user._id != null ? String(req.user._id) : undefined;
    const meta = {
      requestId: req.requestId,
      method: req.method,
      endpoint: req.path,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
      ...(userId ? { userId } : {}),
    };

    if (res.statusCode >= 500) {
      logger.error("HTTP request", meta);
    } else if (res.statusCode >= 400) {
      logger.warn("HTTP request", meta);
    } else {
      logger.info("HTTP request", meta);
    }
  });

  next();
}

module.exports = { requestLogger };
