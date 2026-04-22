const multer = require("multer");
const { AppError } = require("../utils/AppError");
const { logger } = require("../utils/logger");
const { sendError } = require("../utils/response");

function notFound(req, res, _next) {
  return sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
}

/**
 * Maps errors to HTTP status and a safe client-facing message.
 * Never exposes stack or internal details in the JSON body.
 */
function errorHandler(err, req, res, _next) {
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  if (err instanceof AppError) statusCode = err.statusCode;
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") statusCode = 401;
  if (err.name === "ValidationError" || err.name === "CastError") statusCode = 400;
  if (err.code === 11000) statusCode = 409;
  if (err.code === "REQUEST_TIMEOUT_ABORTED") statusCode = 408;
  if (err instanceof multer.MulterError) statusCode = 400;
  if (err.type === "entity.too.large") statusCode = 413;

  logger.error(err.message || "Error", {
    code: err.code,
    name: err.name,
    path: req.originalUrl,
    method: req.method,
    statusCode,
    requestId: req.requestId || null,
    ...(err.stack ? { stack: err.stack } : {}),
  });

  if (res.headersSent) {
    return;
  }

  if (err.type === "entity.too.large") {
    return sendError(res, "Payload too large", 413);
  }

  const isUnexpectedServerError = statusCode >= 500 && !(err instanceof AppError);
  const message = isUnexpectedServerError ? "Something went wrong" : err?.message || "Something went wrong";

  return sendError(res, message, statusCode);
}

module.exports = { notFound, errorHandler };
