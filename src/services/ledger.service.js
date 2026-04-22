const OperatorEarning = require("../models/operatorEarning.model");
const LedgerTransaction = require("../models/transaction.model");
const { logger } = require("../utils/logger");

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Record operator earnings after full payment + settlement (uses booking.operatorEarning and fee fields).
 * Idempotent: unique index on bookingId.
 */
async function recordOperatorEarningFromSettlement(booking) {
  try {
    if (!booking || !booking._id || !booking.operator) return;
    const totalAmount = Math.max(0, Number(booking.totalAmount) || 0);
    const platformFee = Math.max(0, Number(booking.platformFee) || 0);
    const gstAmount = Math.max(0, Number(booking.gstAmount) || 0);
    const operatorEarning = round2(Math.max(0, Number(booking.operatorEarning) || 0));
    await OperatorEarning.create({
      operatorId: booking.operator,
      bookingId: booking._id,
      totalAmount,
      platformFee,
      gstAmount,
      operatorEarning,
    });
  } catch (e) {
    if (e && (e.code === 11000 || e.code === 11001)) return;
    logger.warn("[ledger] operator earning record failed", {
      bookingId: booking?._id?.toString?.(),
      error: e?.message,
    });
  }
}

async function logPaymentSuccess({ userId, bookingId, amount, ledgerKey }) {
  if (!ledgerKey || !String(ledgerKey).trim()) {
    logger.warn("[ledger] payment log skipped: missing ledgerKey", {
      bookingId: bookingId?.toString?.(),
    });
    return;
  }
  try {
    await LedgerTransaction.create({
      ledgerKey: String(ledgerKey).trim(),
      userId,
      bookingId,
      type: "payment",
      amount: Math.max(0, Number(amount) || 0),
      status: "success",
    });
  } catch (e) {
    if (e && (e.code === 11000 || e.code === 11001)) {
      logger.info("[ledger] duplicate payment ledger entry skipped", { ledgerKey });
      return;
    }
    logger.warn("[ledger] payment transaction log failed", {
      bookingId: bookingId?.toString?.(),
      error: e?.message,
    });
  }
}

async function logRefundSuccess({ userId, bookingId, amount, ledgerKey }) {
  if (!ledgerKey || !String(ledgerKey).trim()) {
    logger.warn("[ledger] refund log skipped: missing ledgerKey", {
      bookingId: bookingId?.toString?.(),
    });
    return;
  }
  try {
    await LedgerTransaction.create({
      ledgerKey: String(ledgerKey).trim(),
      userId,
      bookingId,
      type: "refund",
      amount: Math.max(0, Number(amount) || 0),
      status: "success",
    });
  } catch (e) {
    if (e && (e.code === 11000 || e.code === 11001)) {
      logger.info("[ledger] duplicate refund ledger entry skipped", { ledgerKey });
      return;
    }
    logger.warn("[ledger] refund transaction log failed", {
      bookingId: bookingId?.toString?.(),
      error: e?.message,
    });
  }
}

module.exports = {
  recordOperatorEarningFromSettlement,
  logPaymentSuccess,
  logRefundSuccess,
};
