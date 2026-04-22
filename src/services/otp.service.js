const { logger } = require("../utils/logger");
const { AppError } = require("../utils/AppError");
const { isRequestCancelled } = require("../utils/requestContext");

// Node 18+ already has fetch
const fetch = global.fetch || require("node-fetch");

function hasMsg91Keys() {
  const key = process.env.MSG91_AUTH_KEY;
  const template = process.env.MSG91_TEMPLATE_ID;
  return Boolean(key && String(key).trim() && template && String(template).trim());
}

async function sendOTP(phone, otp) {
  if (isRequestCancelled()) {
    logger.warn("Aborted OTP dispatch before provider call");
    throw new AppError("Request timeout.", 408, { code: "REQUEST_TIMEOUT_ABORTED", retryable: true });
  }

  // Development mode: never log OTP values.
  if (process.env.NODE_ENV !== "production") {
    logger.info("OTP dispatch simulated", { channel: "dev" });

    return {
      delivered: true,
      channel: "dev",
    };
  }

  // ✅ PRODUCTION MODE (STRICT)
  if (!hasMsg91Keys()) {
    logger.error("MSG91 not configured");
    throw new AppError(
      "SMS service not configured.",
      503,
      { code: "SMS_NOT_CONFIGURED", retryable: false }
    );
  }

  const authKey = process.env.MSG91_AUTH_KEY.trim();
  const templateId = process.env.MSG91_TEMPLATE_ID.trim();

  const mobile = String(phone).replace(/\D/g, "");
  const dial = mobile.length === 10 ? `91${mobile}` : mobile;

  try {
    if (isRequestCancelled()) {
      logger.warn("Aborted OTP dispatch before outbound fetch");
      throw new AppError("Request timeout.", 408, { code: "REQUEST_TIMEOUT_ABORTED", retryable: true });
    }
    const res = await fetch("https://api.msg91.com/api/v5/otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authkey": authKey
      },
      body: JSON.stringify({
        mobile: dial,
        template_id: templateId,
        otp: String(otp)
      })
    });

    const json = await res.json();

    logger.info("OTP sent successfully", { channel: "msg91", type: json?.type });

    if (!res.ok || json.type !== "success") {
      logger.error("OTP send failed", {
        channel: "msg91",
        type: json?.type,
        message: json?.message || "provider error",
      });
      throw new AppError("Failed to send SMS.", 502, {
        code: "SMS_SEND_FAILED",
        retryable: true,
      });
    }

    return {
      delivered: true,
      channel: "msg91"
    };

  } catch (err) {
    logger.error("OTP send failed", { channel: "msg91", message: err?.message });
    throw new AppError("Failed to send SMS.", 502, {
      code: "SMS_SEND_FAILED",
      retryable: true,
    });
  }
}

module.exports = { sendOTP, hasMsg91Keys };