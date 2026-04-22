const { sendSuccess } = require("../utils/apiResponse");

function getSupport(_req, res) {
  const phone = String(process.env.SUPPORT_PHONE || "+91XXXXXXXXXX").trim();
  const message = String(process.env.SUPPORT_MESSAGE || "Contact support for help").trim();
  return sendSuccess(res, 200, "Support details fetched.", {
    phone,
    message,
  });
}

module.exports = { getSupport };
