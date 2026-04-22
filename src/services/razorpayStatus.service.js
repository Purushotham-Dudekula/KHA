const { logger } = require("../utils/logger");

function hasRazorpayKeys() {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
      String(process.env.RAZORPAY_KEY_ID).trim() &&
      process.env.RAZORPAY_KEY_SECRET &&
      String(process.env.RAZORPAY_KEY_SECRET).trim()
  );
}

function getRazorpay() {
  if (!hasRazorpayKeys()) return null;
  const Razorpay = require("razorpay");
  return new Razorpay({
    key_id: String(process.env.RAZORPAY_KEY_ID).trim(),
    key_secret: String(process.env.RAZORPAY_KEY_SECRET).trim(),
  });
}

/**
 * @returns {Promise<{ ok: true, status: string, raw: any } | { ok: false, error: Error }>}
 */
async function fetchRazorpayPaymentStatus(paymentId) {
  try {
    const pid = String(paymentId || "").trim();
    if (!pid) return { ok: false, error: new Error("Missing payment id") };
    const rzp = getRazorpay();
    if (!rzp) return { ok: false, error: new Error("Razorpay not configured") };
    const p = await rzp.payments.fetch(pid);
    const status = typeof p?.status === "string" ? p.status : "";
    return { ok: true, status, raw: p };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.warn("[razorpay] payment status fetch failed", { message: e.message });
    return { ok: false, error: e };
  }
}

module.exports = { fetchRazorpayPaymentStatus };

