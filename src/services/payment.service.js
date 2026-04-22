const crypto = require("crypto");
const Payment = require("../models/payment.model");
const { logger } = require("../utils/logger");
const { isRequestCancelled } = require("../utils/requestContext");

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

function parseHexDigest(value) {
  const s = String(value || "").trim();
  if (!s || s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/i.test(s)) return null;
  try {
    return Buffer.from(s, "hex");
  } catch {
    return null;
  }
}

function timingSafeEqualHex(a, b) {
  const aa = parseHexDigest(a);
  const bb = parseHexDigest(b);
  if (!aa || !bb || aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

/**
 * @param {number} amount - Amount in INR (rupees)
 */
async function createOrder(amount) {
  if (isRequestCancelled()) {
    logger.warn("Aborted createOrder before Razorpay call");
    throw new Error("Request processing aborted due to timeout.");
  }
  const rzp = getRazorpay();
  const paise = Math.round(Number(amount) * 100);

  if (!hasRazorpayKeys()) {
    throw new Error("Payment service not configured");
  }
  if (!rzp || !Number.isFinite(paise) || paise <= 0) {
    throw new Error("Invalid amount for order creation.");
  }

  try {
    const order = await rzp.orders.create({
      amount: paise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });
    return order;
  } catch (error) {
    logger.error("Razorpay order creation failed", { message: error?.message || String(error) });
    throw new Error("Unable to create payment order right now.");
  }
}

/**
 * Verifies Razorpay payment signature.
 * @param {Record<string, string|undefined>} data - orderId/paymentId/signature (Razorpay or camelCase)
 */
async function verifyPayment(data) {
  if (isRequestCancelled()) {
    logger.warn("Aborted payment verification before signature check");
    throw new Error("Request processing aborted due to timeout.");
  }
  const orderId = data?.razorpay_order_id || data?.orderId || "";
  const paymentId = data?.razorpay_payment_id || data?.paymentId || "";
  const signature = data?.razorpay_signature || data?.signature || "";

  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isDevelopment = nodeEnv === "development";

  logger.info("Payment verification attempt", {
    nodeEnv,
    hasOrderId: Boolean(orderId),
    hasPaymentId: Boolean(paymentId),
    hasSignature: Boolean(signature),
  });

  if (isDevelopment && String(process.env.ALLOW_DEV_PAYMENT || "").trim().toLowerCase() === "true") {
    logger.warn("DEV MODE: Skipping Razorpay verification");
    return {
      verified: true,
      orderId,
      paymentId,
      message: "DEV MODE BYPASS",
    };
  }

  if (!isDevelopment && String(process.env.ALLOW_DEV_PAYMENT || "").trim().toLowerCase() === "true") {
    logger.warn("Dev payment bypass ignored outside development", { nodeEnv });
  }

  if (!hasRazorpayKeys()) {
    throw new Error("Payment service not configured");
  }

  if (!orderId || !paymentId || !signature) {
    return {
      verified: false,
      message: "orderId, paymentId and signature are required for Razorpay verification.",
    };
  }

  const secret = String(process.env.RAZORPAY_KEY_SECRET).trim();
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const verified = timingSafeEqualHex(expected, signature);

  return {
    verified,
    orderId,
    paymentId,
    message: verified ? undefined : "Invalid Razorpay signature.",
  };
}

async function isPaymentIdReused(paymentId, bookingId) {
  const pid = String(paymentId || "").trim();
  if (!pid) return false;
  const query = bookingId
    ? { paymentId: pid, bookingId: { $ne: bookingId } }
    : { paymentId: pid };
  return Boolean(await Payment.exists(query));
}

/**
 * Fetches Razorpay payment amount (in INR) from Razorpay API.
 * Uses the same Razorpay credentials already configured.
 *
 * @param {string} paymentId
 * @returns {Promise<{ ok: true, amountRupees: number, raw: any } | { ok: false, error: Error }>}
 */
async function fetchPaymentAmountRupees(paymentId) {
  try {
    if (isRequestCancelled()) {
      logger.warn("Aborted Razorpay payment fetch before outbound call");
      return { ok: false, error: new Error("Request processing aborted due to timeout.") };
    }
    const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
    const isProduction = nodeEnv === "production";
    if (!isProduction) {
      logger.warn("DEV MODE: Skipping Razorpay payment amount fetch");
      return { ok: true, amountRupees: undefined, raw: null };
    }

    const rzp = getRazorpay();
    if (!rzp || !paymentId) {
      return { ok: false, error: new Error("Razorpay not configured or missing payment id.") };
    }
    const p = await rzp.payments.fetch(String(paymentId));
    const paise = Number(p?.amount);
    if (!Number.isFinite(paise) || paise < 0) {
      return { ok: false, error: new Error("Invalid Razorpay payment amount.") };
    }
    return { ok: true, amountRupees: paise / 100, raw: p };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Full refund in INR via Razorpay (amount passed to API in paise).
 * @param {string} razorpayPaymentId
 * @param {number} amountRupees
 * @returns {Promise<{ ok: true, refund: object } | { ok: false, error: Error }>}
 */
async function refundUpiPayment(razorpayPaymentId, amountRupees) {
  if (isRequestCancelled()) {
    logger.warn("Aborted Razorpay refund before outbound call");
    return { ok: false, error: new Error("Request processing aborted due to timeout.") };
  }
  const rzp = getRazorpay();
  const amountPaise = Math.round(Number(amountRupees) * 100);

  if (!rzp || !razorpayPaymentId) {
    return { ok: false, error: new Error("Razorpay not configured or missing payment id.") };
  }
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return { ok: false, error: new Error("Invalid refund amount.") };
  }

  try {
    const refund = await rzp.payments.refund(razorpayPaymentId, { amount: amountPaise });
    return { ok: true, refund };
  } catch (err) {
    return { ok: false, error: err };
  }
}

module.exports = {
  createOrder,
  verifyPayment,
  hasRazorpayKeys,
  fetchPaymentAmountRupees,
  refundUpiPayment,
  isPaymentIdReused,
};
