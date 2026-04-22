class AppError extends Error {
  /**
   * @param {string} message - Technical / primary message
   * @param {number} statusCode - HTTP status
   * @param {{ code?: string, userTip?: string, retryable?: boolean }} [meta]
   */
  constructor(message, statusCode = 500, meta = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = meta.code;
    this.userTip = meta.userTip;
    this.retryable = meta.retryable;
  }
}

module.exports = { AppError };
