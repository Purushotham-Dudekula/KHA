const Payment = require("../models/payment.model");
const { logger } = require("../utils/logger");
const { finalizeRazorpayPaymentCaptured } = require("./paymentFinalizer.service");

async function resolveBookingIdForPayment(paymentId) {
  const pid = String(paymentId || "").trim();
  if (!pid) return null;
  try {
    const row = await Payment.findOne({ paymentId: pid }).select("bookingId").lean();
    return row?.bookingId ? String(row.bookingId) : null;
  } catch {
    return null;
  }
}

async function logFinalizerFailure(params, errOrResult) {
  const paymentId = params?.paymentId ?? null;
  const bookingId = await resolveBookingIdForPayment(paymentId);
  logger.error("[PAYMENT_FINALIZER_FAILURE] Payment finalization did not succeed", {
    tag: "PAYMENT_FINALIZER_FAILURE",
    operation: "finalizeRazorpayPaymentCaptured",
    paymentId,
    bookingId,
    source: params?.source ?? null,
    webhookEvent: params?.webhookEvent ?? null,
    code: errOrResult?.code ?? null,
    message: errOrResult?.message || String(errOrResult || ""),
  });
}

/**
 * Calls the finalizer and never returns a silent failure: ok:false becomes a thrown Error after logging.
 */
async function invokeFinalizeRazorpayPaymentCaptured(params) {
  let result;
  try {
    result = await finalizeRazorpayPaymentCaptured(params);
  } catch (err) {
    await logFinalizerFailure(params, err);
    throw err;
  }
  if (!result?.ok) {
    await logFinalizerFailure(params, result);
    throw new Error(result?.message || "Payment finalization failed.");
  }
  return result;
}

module.exports = { invokeFinalizeRazorpayPaymentCaptured };
