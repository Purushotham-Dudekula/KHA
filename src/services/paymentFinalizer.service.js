const mongoose = require("mongoose");
const Payment = require("../models/payment.model");
const Booking = require("../models/booking.model");
const { logger } = require("../utils/logger");
const { acquireLock, releaseLock } = require("./redisLock.service");

function safeString(v) {
  return v == null ? "" : String(v);
}

/**
 * Single source of truth for finalizing a payment based on provider confirmation.
 * Idempotent:
 * - If payment already SUCCESS, it is a no-op.
 * - Booking update is conditional and never downgrades terminal states.
 *
 * @param {object} params
 * @param {string} params.paymentId Razorpay payment id
 * @param {string} params.webhookEvent e.g. "payment.captured"
 * @param {string} params.source "webhook" | "reconciliation"
 */
async function finalizeRazorpayPaymentCaptured({ paymentId, webhookEvent, source }) {
  const pid = safeString(paymentId).trim();
  if (!pid) {
    return { ok: false, code: "MISSING_PAYMENT_ID" };
  }

  try {
    // Prevent webhook vs cron race in distributed systems.
    const lockKey = `lock:payment:finalize:${pid}`;
    const lock = await acquireLock(lockKey, 30_000);
    if (!lock.acquired) {
      throw new Error("Payment finalization lock failed");
    }

    const session = await mongoose.startSession();
    let updatedPayment = null;
    let updatedBooking = null;
    let alreadyProcessed = false;

    try {
      await session.withTransaction(async () => {
        const payment = await Payment.findOne({ paymentId: pid }).session(session);
        if (!payment) {
          const err = new Error("PAYMENT_NOT_FOUND");
          err.code = "PAYMENT_NOT_FOUND";
          throw err;
        }

        if (payment.status === "SUCCESS" || payment.status === "REFUNDED") {
          alreadyProcessed = true;
          updatedPayment = payment;
          const booking = await Booking.findById(payment.bookingId).session(session);
          updatedBooking = booking;
          return;
        }

        payment.status = "SUCCESS";
        updatedPayment = await payment.save({ session });

        const booking = await Booking.findById(payment.bookingId).session(session);
        if (!booking) {
          const err = new Error("BOOKING_NOT_FOUND");
          err.code = "BOOKING_NOT_FOUND";
          throw err;
        }

        // Webhook is final source of truth. Only promote; never downgrade.
        // - advance: accepted/payment_pending -> confirmed
        // - remaining: payment_pending + fully_paid -> closed
        if (payment.type === "advance") {
          if (booking.status === "accepted" || booking.status === "payment_pending") {
            booking.status = "confirmed";
            booking.lockExpiresAt = null;
            updatedBooking = await booking.save({ session });
          } else {
            updatedBooking = booking;
          }
        } else if (payment.type === "remaining") {
          if (booking.status === "payment_pending" && booking.paymentStatus === "fully_paid") {
            booking.status = "closed";
            booking.lockExpiresAt = null;
            updatedBooking = await booking.save({ session });
          } else {
            updatedBooking = booking;
          }
        } else {
          updatedBooking = booking;
        }
      });

      logger.info("[PAYMENT_FINALIZE] Razorpay captured finalized", {
        type: "PAYMENT",
        action: "payment.finalize",
        source,
        webhookEvent: webhookEvent || null,
        paymentId: pid,
        bookingId: updatedPayment?.bookingId ? String(updatedPayment.bookingId) : null,
        paymentStatus: updatedPayment?.status || null,
        bookingStatus: updatedBooking?.status || null,
        alreadyProcessed,
        timestamp: new Date().toISOString(),
      });

      // Data consistency safeguard: payment SUCCESS but booking not confirmed (advance).
      if (updatedPayment?.status === "SUCCESS" && updatedPayment?.type === "advance") {
        const bs = updatedBooking?.status || null;
        if (bs && bs !== "confirmed") {
          logger.error("[ALERT] Payment-booking mismatch after finalize", {
            type: "ALERT",
            severity: "HIGH",
            message: "Payment SUCCESS but booking not confirmed after webhook finalization",
            bookingId: updatedPayment?.bookingId ? String(updatedPayment.bookingId) : null,
            paymentId: pid,
            action: "payment.finalize_mismatch",
            status: "MISMATCH",
            timestamp: new Date().toISOString(),
          });
        }
      }

      return {
        ok: true,
        paymentId: pid,
        bookingId: updatedPayment?.bookingId || null,
        alreadyProcessed,
      };
    } finally {
      await session.endSession();
      try {
        await releaseLock(lockKey, lock.token);
      } catch {
        // ignore
      }
    }
  } catch (e) {
    logger.error("[PAYMENT_FINALIZE] Finalization failed", {
      source,
      webhookEvent: webhookEvent || null,
      paymentId: pid,
      code: e?.code || null,
      message: e?.message || String(e),
    });
    return { ok: false, code: e?.code || "FINALIZE_FAILED", message: e?.message || String(e) };
  }
}

module.exports = { finalizeRazorpayPaymentCaptured };

