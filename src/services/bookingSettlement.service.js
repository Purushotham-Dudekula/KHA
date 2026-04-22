const Booking = require("../models/booking.model");
const Commission = require("../models/commission.model");
const { DEFAULT_GST_RATE } = require("../constants/financial");
const { logger } = require("../utils/logger");
const { recordOperatorEarningFromSettlement } = require("./ledger.service");
const { getActiveCommissionCached } = require("./commissionCache.service");

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Full payment is done: booking is closed and paymentStatus is final (`fully_paid` canonical, legacy `paid` supported).
 * Escrow semantics: funds are platform-held until this state; no automatic payout is performed.
 */
function isFullPaymentSettled(booking) {
  if (!booking) return false;
  if (booking.status !== "closed") return false;
  return ["fully_paid", "paid"].includes(booking.paymentStatus);
}

/**
 * After farmer pays remaining balance: recompute platform fee, GST, and operator share from totalAmount,
 * persist on booking, and record OperatorEarning (idempotent via unique bookingId).
 * Does not change payment capture flow — only runs once booking is closed + paid.
 */
async function applyBookingSettlementAfterFullPayment(bookingId) {
  const id = bookingId && bookingId._id ? bookingId._id : bookingId;
  if (!id) return { ok: false, reason: "missing_id" };

  const booking = await Booking.findById(id);
  if (!booking) return { ok: false, reason: "not_found" };

  if (!isFullPaymentSettled(booking)) {
    return { ok: false, reason: "not_settled" };
  }

  const activeCommission = await getActiveCommissionCached(300);
  const platformFeePercent = Number(activeCommission?.percentage);
  if (!Number.isFinite(platformFeePercent) || platformFeePercent < 0) {
    logger.warn("[settlement] Skipped: no active commission", {
      event: "settlement_skipped",
      reason: "no_commission",
      bookingId: String(id),
    });
    return { ok: false, reason: "no_commission" };
  }

  const totalAmount = Math.max(0, Number(booking.totalAmount) || 0);
  const platformFee = round2(totalAmount * (platformFeePercent / 100));
  const gstAmount = round2(totalAmount * DEFAULT_GST_RATE);
  const operatorEarning = round2(Math.max(0, totalAmount - platformFee - gstAmount));

  booking.platformFee = platformFee;
  booking.gstAmount = gstAmount;
  booking.operatorEarning = operatorEarning;
  await booking.save();

  await recordOperatorEarningFromSettlement(booking);

  logger.info("[EVENT] Settlement executed", {
    event: "settlement_applied",
    bookingId: String(id),
    operatorEarning,
    totalAmount,
    platformFee,
  });

  return { ok: true };
}

module.exports = {
  applyBookingSettlementAfterFullPayment,
  isFullPaymentSettled,
};
