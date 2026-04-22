const nodemailer = require("nodemailer");
const { AppError } = require("../utils/AppError");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");

function hasAdminSmtpConfig() {
  const host = (process.env.SMTP_HOST || "").trim();
  const from = String(process.env.ADMIN_EMAIL_FROM || "").trim();
  return Boolean(host && from);
}

/**
 * Sends admin login OTP via SMTP only. No console fallback.
 */
async function sendAdminLoginOtpEmail(toEmail, plainOtp) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const from = String(process.env.ADMIN_EMAIL_FROM || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USER || process.env.MAIL_USER || "").trim();
  const pass = (process.env.SMTP_PASS || process.env.MAIL_PASS || "").trim();
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  if (!host || !from) {
    logger.error("Admin SMTP misconfiguration: SMTP_HOST or ADMIN_EMAIL_FROM empty");
    throw new AppError(
      "Admin email (SMTP) is not configured. Set SMTP_HOST and ADMIN_EMAIL_FROM.",
      503,
      { code: "ADMIN_EMAIL_NOT_CONFIGURED", retryable: false }
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  const subject = "Your admin login code";
  const text = `Your one-time login code is: ${plainOtp}. It expires in 5 minutes.`;
  const html = `<p>Your one-time login code is: <strong>${plainOtp}</strong></p><p>It expires in 5 minutes.</p>`;

  await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    text,
    html,
  });
}

/**
 * Delivers admin login OTP by email (SMTP). Throws if SMTP is not configured or send fails.
 */
async function deliverAdminLoginOtp(toEmail, plainOtp) {
  if (!env.enableEmails) {
    logger.warn("[EMAIL_ERROR] deliverAdminLoginOtp blocked (emails disabled)", {
      tag: "EMAIL_ERROR",
      operation: "deliverAdminLoginOtp",
    });
    throw new AppError("Email delivery is disabled.", 503, {
      code: "EMAILS_DISABLED",
      userTip: "Contact an administrator.",
      retryable: false,
    });
  }
  if (!hasAdminSmtpConfig()) {
    logger.error("Admin SMTP not configured: SMTP_HOST or ADMIN_EMAIL_FROM missing");
    throw new AppError(
      "Admin email (SMTP) is not configured. Set SMTP_HOST and ADMIN_EMAIL_FROM.",
      503,
      { code: "ADMIN_EMAIL_NOT_CONFIGURED", retryable: false }
    );
  }

  try {
    await sendAdminLoginOtpEmail(toEmail, plainOtp);
  } catch (err) {
    logger.error("Admin login OTP email failed", { message: err?.message });
    if (err instanceof AppError) throw err;
    throw new AppError("Failed to send login email. Please try again.", 502, {
      code: "ADMIN_EMAIL_SEND_FAILED",
      retryable: true,
    });
  }
}

module.exports = {
  hasAdminSmtpConfig,
  sendAdminLoginOtpEmail,
  deliverAdminLoginOtp,
};
