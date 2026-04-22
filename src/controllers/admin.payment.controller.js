const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const User = require("../models/user.model");
const Commission = require("../models/commission.model");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");
const { notifyUser } = require("../services/notification.service");
const { refundUpiPayment } = require("../services/payment.service");
const { logRefundSuccess } = require("../services/ledger.service");
const { resolveRefundSnapshot } = require("../utils/refundCalculation");
const { logAuditAction } = require("../services/auditLog.service");
const { logAdminActivity } = require("../services/adminActivityLog.service");

async function processRefund(req, res, next) {
  try {
    const { bookingId } = req.params;
    const { action, refundReason } = req.body || {};

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      res.status(400);
      throw new Error("Valid bookingId is required.");
    }
    if (!["approve", "reject"].includes(action)) {
      res.status(400);
      throw new Error('action must be "approve" or "reject".');
    }

    let booking = await Booking.findById(bookingId);
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (booking.status === "cancelled") {
      const actorIsFarmer = booking.cancelledBy === "farmer";
      const policySnap = resolveRefundSnapshot(booking, { actorIsFarmer });
      const ra = Number(booking.refundAmount) || 0;
      const cc = Number(booking.cancellationCharge) || 0;
      if (
        Math.abs(ra - policySnap.refundAmount) > 0.02 ||
        Math.abs(cc - policySnap.penalty) > 0.02
      ) {
        logger.warn("[REFUND] Stored cancellation snapshot differs from policy resolver", {
          bookingId: booking._id.toString(),
          stored: { refundAmount: ra, cancellationCharge: cc },
          policy: policySnap,
          cancelledBy: booking.cancelledBy,
        });
      }
    }

    const reasonTrim = typeof refundReason === "string" ? refundReason.trim() : "";

    // Atomic processing guard:
    // - only one request can transition refundStatus away from "pending"
    // - all subsequent requests must be rejected to prevent double refunds
    const rejectAlreadyProcessed = async () => {
      const fresh = await Booking.findById(bookingId).select("refundStatus").lean();
      const rs = fresh?.refundStatus ?? booking?.refundStatus ?? null;
      logger.info("[EVENT] Refund skipped (already processed)", {
        bookingId: String(bookingId),
        refundStatus: rs,
      });
      return res.status(409).json({
        success: false,
        message: "Refund already processed",
        bookingId: booking?._id || bookingId,
        refundStatus: rs,
      });
    };

    if (action === "reject") {
      logger.info("[EVENT] Refund reject attempt started", {
        event: "refund_attempt_start",
        action: "reject",
        bookingId: booking._id.toString(),
        priorRefundStatus: booking.refundStatus,
      });

      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, refundStatus: "pending" },
        { $set: { refundStatus: "rejected", refundReason: reasonTrim } },
        { new: true }
      );
      if (!claimed) {
        return await rejectAlreadyProcessed();
      }
      booking = claimed;

      await Payment.updateMany(
        { bookingId: booking._id, status: "SUCCESS" },
        {
          $set: {
            refundStatus: "rejected",
            refundReason: reasonTrim,
          },
        }
      );

      logger.info("[EVENT] Refund reject attempt finished", {
        event: "refund_attempt_finished",
        action: "reject",
        bookingId: booking._id.toString(),
        refundStatus: booking.refundStatus,
      });
      logger.info("[EVENT] Refund reject completed", {
        bookingId: booking._id.toString(),
        refundStatus: booking.refundStatus,
      });
      void logAuditAction(req.admin?._id, "REFUND_REJECTED");
    } else {
      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, refundStatus: "pending" },
        { $set: { refundStatus: "approved", refundReason: reasonTrim } },
        { new: true }
      );
      if (!claimed) {
        return await rejectAlreadyProcessed();
      }
      booking = claimed;

      const payments = await Payment.find({
        bookingId: booking._id,
        status: "SUCCESS",
      }).lean();

      logger.info("[EVENT] Refund approve attempt started", {
        event: "refund_attempt_start",
        action: "approve",
        bookingId: booking._id.toString(),
        priorRefundStatus: booking.refundStatus,
        successPaymentCount: payments.length,
      });

      let anyFailure = false;
      let attemptedCount = 0;
      let razorpayOkCount = 0;
      let razorpayFailCount = 0;
      let manualOkCount = 0;
      let skippedProcessedCount = 0;

      for (const p of payments) {
        try {
          if (p.refundStatus === "processed") {
            skippedProcessedCount += 1;
            logger.info("[REFUND] Payment skipped (already processed)", {
              bookingId: booking._id.toString(),
              paymentDocId: p._id.toString(),
            });
            continue;
          }

          if (p.status === "REFUNDED") {
            skippedProcessedCount += 1;
            logger.info("[REFUND] Payment skipped (already refunded)", {
              bookingId: booking._id.toString(),
              paymentDocId: p._id.toString(),
            });
            continue;
          }

          const isUpi = p.paymentMethod === "upi";
          const hasRefundId = Boolean(p.refundId && String(p.refundId).trim());
          const legacyManualApproved =
            p.refundStatus === "approved" && p.refundedAt && !hasRefundId;

          if (isUpi && p.paymentId && !legacyManualApproved) {
            attemptedCount += 1;
            const result = await refundUpiPayment(p.paymentId, p.amount);
            if (result.ok) {
              razorpayOkCount += 1;
              const rid = result.refund?.id != null ? String(result.refund.id) : "";
              await Payment.updateOne(
                { _id: p._id },
                {
                  $set: {
                    status: "REFUNDED",
                    refundStatus: "processed",
                    refundReason: reasonTrim,
                    refundedAt: new Date(),
                    refundId: rid,
                  },
                }
              );
              const walletCreditUpdate = await Payment.updateOne(
                {
                  _id: p._id,
                  walletDebitedAt: { $ne: null },
                  walletRefundCreditedAt: null,
                },
                {
                  $set: { walletRefundCreditedAt: new Date() },
                }
              );
              if (walletCreditUpdate?.modifiedCount) {
                await User.updateOne(
                  { _id: p.userId },
                  { $inc: { wallet: Number(p.amount || 0) } }
                );
              }
              await logRefundSuccess({
                userId: p.userId,
                bookingId: booking._id,
                amount: p.amount,
                ledgerKey: `refund:${p._id}`,
              });
              logger.info("[REFUND] Razorpay refund succeeded", {
                bookingId: booking._id.toString(),
                paymentDocId: p._id.toString(),
                razorpayPaymentId: p.paymentId,
                refundId: rid,
                amount: p.amount,
              });
            } else {
              razorpayFailCount += 1;
              logger.error("[REFUND] Razorpay refund failed", {
                bookingId: booking._id.toString(),
                paymentDocId: p._id.toString(),
                razorpayPaymentId: p.paymentId,
                error: result.error?.message || String(result.error),
              });
              await Payment.updateOne(
                { _id: p._id },
                {
                  $set: {
                    refundStatus: "pending",
                    refundReason: reasonTrim,
                  },
                }
              );
              anyFailure = true;
            }
            continue;
          }

          if (isUpi && (!p.paymentId || legacyManualApproved)) {
            if (!p.paymentId) {
              attemptedCount += 1;
              logger.warn("[REFUND] UPI refund cannot proceed (no Razorpay payment id)", {
                bookingId: booking._id.toString(),
                paymentDocId: p._id.toString(),
              });
              await Payment.updateOne(
                { _id: p._id },
                { $set: { refundStatus: "pending", refundReason: reasonTrim } }
              );
              anyFailure = true;
            }
            continue;
          }

          attemptedCount += 1;
          await Payment.updateOne(
            { _id: p._id },
            {
              $set: {
                status: "REFUNDED",
                refundStatus: "approved",
                refundReason: reasonTrim,
                refundedAt: new Date(),
              },
            }
          );
          const walletCreditUpdate = await Payment.updateOne(
            {
              _id: p._id,
              walletDebitedAt: { $ne: null },
              walletRefundCreditedAt: null,
            },
            {
              $set: { walletRefundCreditedAt: new Date() },
            }
          );
          if (walletCreditUpdate?.modifiedCount) {
            await User.updateOne(
              { _id: p.userId },
              { $inc: { wallet: Number(p.amount || 0) } }
            );
          }
          await logRefundSuccess({
            userId: p.userId,
            bookingId: booking._id,
            amount: p.amount,
            ledgerKey: `refund:${p._id}`,
          });
          manualOkCount += 1;
          logger.info("[REFUND] Manual / non-UPI refund bookkeeping recorded", {
            bookingId: booking._id.toString(),
            paymentDocId: p._id.toString(),
            paymentMethod: p.paymentMethod,
            amount: p.amount,
          });
        } catch (e) {
          logger.warn("[REFUND] Payment refund step threw", {
            bookingId: booking._id.toString(),
            paymentDocId: p._id?.toString?.(),
            error: e?.message,
          });
          anyFailure = true;
        }
      }

      booking.refundStatus = anyFailure ? "partial_failed" : "approved";
      booking.refundReason = reasonTrim;
      await booking.save();

      logger.info("[EVENT] Admin refund approve attempt finished", {
        event: "refund_attempt_finished",
        bookingId: booking._id.toString(),
        refundStatus: booking.refundStatus,
        attemptedCount,
        skippedProcessedCount,
        razorpayOkCount,
        razorpayFailCount,
        manualOkCount,
        anyFailure,
      });
      logger.info("[EVENT] Refund approve completed", {
        bookingId: booking._id.toString(),
        refundStatus: booking.refundStatus,
      });
      void logAuditAction(req.admin?._id, "REFUND_APPROVED");

      try {
        let title;
        let message;
        if (booking.refundStatus === "partial_failed") {
          title = "Refund partially failed";
          message =
            "Some refund steps could not be completed. Please check with support if money is still due.";
        } else {
          title = "Refund approved";
          message =
            "Your refund has been approved. We will update you once it is processed.";
        }

        await Promise.all([
          notifyUser({
            req,
            app: null,
            userId: booking.farmer,
            message,
            type: "alert",
            title,
            bookingId: booking._id,
          }),
          notifyUser({
            req,
            app: null,
            userId: booking.operator,
            message,
            type: "alert",
            title,
            bookingId: booking._id,
          }),
        ]);
      } catch {
        // Do not fail the API if notifications fail.
      }

      if (booking.refundStatus === "partial_failed") {
        return res.status(200).json({
          success: false,
          message: "Refund partially failed",
          bookingId: booking._id,
          refundStatus: booking.refundStatus,
        });
      }

      void logAdminActivity({
        adminId: req.admin?._id,
        action: "REFUND_APPROVED",
        targetId: booking._id,
        targetType: "booking",
        metadata: { refundStatus: booking.refundStatus },
      });
      return sendSuccess(res, 200, "Refund status updated.", {
        bookingId: booking._id,
        refundStatus: booking.refundStatus,
        refundReason: booking.refundReason,
      });
    }

    try {
      const title = "Refund rejected";
      const message =
        "Your refund has been rejected. If you believe this is an error, contact support.";

      await Promise.all([
        notifyUser({
          req,
          app: null,
          userId: booking.farmer,
          message,
          type: "alert",
          title,
          bookingId: booking._id,
        }),
        notifyUser({
          req,
          app: null,
          userId: booking.operator,
          message,
          type: "alert",
          title,
          bookingId: booking._id,
        }),
      ]);
    } catch {
      // Do not fail the API if notifications fail.
    }

    void logAdminActivity({
      adminId: req.admin?._id,
      action: "REFUND_REJECTED",
      targetId: booking._id,
      targetType: "booking",
      metadata: { refundStatus: booking.refundStatus },
    });
    return sendSuccess(res, 200, "Refund status updated.", {
      bookingId: booking._id,
      refundStatus: booking.refundStatus,
      refundReason: booking.refundReason,
    });
  } catch (error) {
    return next(error);
  }
}

async function upsertCommission(req, res, next) {
  try {
    const { percentage, active } = req.body || {};

    if (percentage === undefined || percentage === null || percentage === "") {
      res.status(400);
      throw new Error("percentage is required.");
    }

    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      res.status(400);
      throw new Error("percentage must be between 0 and 100.");
    }

    const isActive = active === undefined ? true : Boolean(active);

    const session = await mongoose.startSession();
    let commission;
    try {
      await session.withTransaction(async () => {
        if (isActive) {
          await Commission.updateMany({ active: true }, { $set: { active: false } }).session(session);
        }
        const [created] = await Commission.create([{ percentage: pct, active: isActive }], { session });
        commission = created;
      });
    } catch (e) {
      // If concurrent requests raced, partial unique index may reject the second "active: true" insert.
      if (isActive && e && (e.code === 11000 || e.code === 11001)) {
        const activeCommission = await Commission.findOne({ active: true }).sort({ updatedAt: -1 });
        if (activeCommission) {
          commission = activeCommission;
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    } finally {
      await session.endSession();
    }

    logger.info(`[EVENT] Commission updated: ${pct}% active=${isActive}`);
    await logAuditAction(req.admin?._id, "UPSERT_COMMISSION", commission._id, {
      percentage: pct,
      active: isActive,
    });
    return sendSuccess(res, 200, "Commission updated.", { commission });
  } catch (error) {
    return next(error);
  }
}

async function getCommission(_req, res, next) {
  try {
    const activeCommission = await Commission.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    return sendSuccess(res, 200, "Commission fetched.", { activeCommission });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  processRefund,
  upsertCommission,
  getCommission,
};
