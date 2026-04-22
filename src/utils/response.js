function sendSuccess(res, data, message, statusCode = 200, pagination = null) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    pagination,
  });
}

function sendError(res, message, statusCode = 400, errors = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    errors,
  });
}

module.exports = { sendSuccess, sendError };
