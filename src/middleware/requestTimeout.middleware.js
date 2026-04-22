const { logger } = require("../utils/logger");
const { getRequestContext } = require("../utils/requestContext");

const DEFAULT_MS = 120000;

/**
 * Ends requests that run longer than `ms` with 408 (if headers not yet sent).
 */
function requestTimeout(ms = DEFAULT_MS) {
  return (req, res, next) => {
    const timeoutMs = Number(ms) > 0 ? Number(ms) : DEFAULT_MS;
    const controller = new AbortController();
    let settled = false;
    req.requestAbortController = controller;
    req.requestAbortSignal = controller.signal;

    const markCancelled = () => {
      const context = getRequestContext();
      if (context) {
        context.cancelled = true;
      }
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    const t = setTimeout(() => {
      if (settled) return;
      markCancelled();
      if (!res.headersSent && !res.writableEnded) {
        settled = true;
        logger.warn("Request timeout", { path: req.originalUrl, method: req.method });
        res.status(408).json({
          success: false,
          message: "Request timeout.",
        });
      }
    }, timeoutMs);

    res.on("finish", () => {
      settled = true;
      clearTimeout(t);
    });
    res.on("close", () => {
      settled = true;
      clearTimeout(t);
      if (!res.writableEnded) {
        markCancelled();
      }
    });
    next();
  };
}

module.exports = { requestTimeout };
