const mongoose = require("mongoose");
const Booking = require("../../models/booking.model");
const { applyAdvanceFieldDedupe } = Booking;
const User = require("../../models/user.model");
const Tractor = require("../../models/tractor.model");
const Payment = require("../../models/payment.model");
const Pricing = require("../../models/pricing.model");
const SeasonalPricing = require("../../models/seasonalPricing.model");
const Commission = require("../../models/commission.model");
const Offer = require("../../models/offer.model");
const { getActiveCommissionCached } = require("../../services/commissionCache.service");
const { getPricingByServiceTypeCached } = require("../../services/pricingCache.service");
const { notifyUser, notifyAdvanceReceived } = require("../../services/notification.service");
const {
  verifyPayment,
  fetchPaymentAmountRupees,
  isPaymentIdReused,
} = require("../../services/payment.service");
const { logPaymentSuccess } = require("../../services/ledger.service");
const { applyBookingSettlementAfterFullPayment } = require("../../services/bookingSettlement.service");
const { fetchRazorpayPaymentStatus } = require("../../services/razorpayStatus.service");
const { invokeFinalizeRazorpayPaymentCaptured } = require("../../services/paymentFinalizerInvoke.service");
const { resolveRefundSnapshot } = require("../../utils/refundCalculation");
const { AppError } = require("../../utils/AppError");
const userFacing = require("../../constants/userFacing");
const { cleanUserResponse } = require("../../utils/cleanUserResponse");
const { canOperatorServeBookings } = require("../../services/operatorEligibility.service");
const { getDistanceAndETA } = require("../../services/maps.service");
const { sendSuccess } = require("../../utils/apiResponse");
const { logger } = require("../../utils/logger");
const { uploadFile, resolveDocumentInput } = require("../../services/storage.service");
const { logAuditAction } = require("../../services/auditLog.service");
const { acquireLock, releaseLock } = require("../../services/redisLock.service");
const { createBookingFlow } = require("../../services/bookingLifecycle.service");
const { isPaymentsEnabled } = require("../../utils/featureFlags");

/** Operator cannot accept another booking while these are open. */
const OPERATOR_RESPOND_BUSY_STATUSES = ["accepted", "confirmed", "en_route", "in_progress"];

const { DEFAULT_GST_RATE: GST_RATE } = require("../../constants/financial");
const ADVANCE_RATE = 0.3;
const { PAYMENT_PENDING_TTL_MS } = require("../../jobs/bookingPaymentLock.cron");

const FARMER_DUPLICATE_BOOKING_STATUSES = Booking.FARMER_ACTIVE_BOOKING_STATUSES;

const OPERATOR_PUBLIC_SELECT =
  "name phone village role isOnline averageRating reviewCount verificationStatus aadhaarVerified";
const FARMER_PUBLIC_SELECT = "name phone village role landArea";

const ACTION_BLOCKED_STATUSES = new Set(["cancelled", "closed", "rejected"]);
const PAYMENT_TERMINAL_STATUSES = new Set(["cancelled", "closed", "rejected"]);
/** Final payment recorded (canonical `fully_paid`; legacy `paid` still supported). */
const PAID_LIKE_PAYMENT_STATUSES = ["fully_paid", "paid"];
function isPaidLikePaymentStatus(paymentStatus) {
  return PAID_LIKE_PAYMENT_STATUSES.includes(paymentStatus);
}
const STATUS_MESSAGE_MAP = {
  pending: "Waiting for operator to accept",
  accepted: "Operator accepted, please pay advance",
  confirmed: "Booking confirmed",
  in_progress: "Work is in progress",
  completed: "Work completed, please pay remaining",
  closed: "Booking completed successfully",
  cancelled: "Booking cancelled",
};

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function buildPaymentLogContext({ req, bookingId, paymentId, stage, error }) {
  return {
    type: "PAYMENT",
    userId: req?.user?._id ? String(req.user._id) : null,
    bookingId: bookingId ? String(bookingId) : null,
    paymentId: paymentId || null,
    paymentStage: stage || null,
    requestId: req?.requestId || null,
    timestamp: new Date().toISOString(),
    ...(error ? { error: error?.message || String(error) } : {}),
  };
}

function schedulePaymentRecoveryCheck({ paymentId, bookingId }) {
  const pid = typeof paymentId === "string" ? paymentId.trim() : "";
  if (!pid) return;
  const delayMs = 45_000;
  const timer = setTimeout(async () => {
    try {
      if (!isPaymentsEnabled()) {
        logger.info("[PAYMENT_QUEUE_SKIP] Recovery timer skipped (payments disabled)", {
          tag: "PAYMENT_QUEUE_SKIP",
          paymentId: pid,
          bookingId: bookingId ? String(bookingId) : null,
        });
        return;
      }
      const statusResult = await fetchRazorpayPaymentStatus(pid);
      if (!statusResult.ok) return;
      if (String(statusResult.status || "").toLowerCase() !== "captured") return;
      logger.warn("[RECOVERY] Webhook delayed, manual verification triggered", {
        type: "PAYMENT",
        action: "payment.recovery",
        status: "RECOVERY_TRIGGERED",
        paymentId: pid,
        bookingId: bookingId ? String(bookingId) : null,
        timestamp: new Date().toISOString(),
      });
      await invokeFinalizeRazorpayPaymentCaptured({
        paymentId: pid,
        webhookEvent: "payment.captured",
        source: "recovery",
      });
    } catch (error) {
      logger.error("[PAYMENT_ERROR] Payment recovery finalize failed", {
        tag: "PAYMENT_ERROR",
        operation: "schedulePaymentRecoveryCheck",
        type: "PAYMENT",
        action: "payment.failed",
        status: "FAILED",
        paymentId: pid,
        bookingId: bookingId ? String(bookingId) : null,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }, delayMs);
  if (typeof timer?.unref === "function") timer.unref();
}

function assertBookingTransition(fromStatus, toStatus, actionLabel) {
  // Canonical strict map (requested):
  // REQUESTED → ACCEPTED → PAYMENT_PENDING → CONFIRMED → IN_PROGRESS → COMPLETED
  // We do not rename stored statuses; we validate on the existing ones.
  const allowed = new Map([
    ["pending", new Set(["accepted", "rejected", "cancelled"])],
    // Strict path for payments: accepted -> payment_pending -> confirmed
    ["accepted", new Set(["payment_pending", "cancelled"])],
    // payment_pending transitions:
    // - after advance webhook: payment_pending -> confirmed
    // - after remaining webhook: payment_pending -> closed
    ["payment_pending", new Set(["confirmed", "closed", "cancelled"])],
    ["confirmed", new Set(["in_progress", "cancelled"])],
    ["en_route", new Set(["in_progress", "cancelled"])],
    ["in_progress", new Set(["completed", "cancelled"])],
    // Keep current behavior: completed can be closed after remaining payment settlement.
    ["completed", new Set(["payment_pending", "closed", "cancelled"])],
  ]);

  const set = allowed.get(fromStatus);
  if (!set || !set.has(toStatus)) {
    throw new AppError(
      `Invalid booking status transition: ${fromStatus} → ${toStatus}`,
      400,
      {
        code: "INVALID_BOOKING_TRANSITION",
        userTip: `Cannot ${actionLabel || "update booking"} from '${fromStatus}' to '${toStatus}'.`,
        retryable: false,
      }
    );
  }
}

function logStatusTransition({ event, bookingId, userId, before, after, paymentId, idempotencyKey }) {
  logger.info(event, {
    bookingId: bookingId ? String(bookingId) : null,
    userId: userId ? String(userId) : null,
    paymentId: paymentId || null,
    idempotencyKey: idempotencyKey || null,
    before,
    after,
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  // Great-circle distance (Haversine). Returns kilometers.
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function assertNotActionBlocked(booking) {
  if (!booking) return;
  if (ACTION_BLOCKED_STATUSES.has(booking.status)) {
    throw new AppError(`This booking is ${booking.status} and no further actions are allowed.`, 400, {
      code: "BOOKING_TERMINAL",
      userTip: "If you need help, contact support with your booking id.",
      retryable: false,
    });
  }
}

function assertPaymentNotTerminal(booking) {
  if (!booking) return;
  if (PAYMENT_TERMINAL_STATUSES.has(booking.status)) {
    throw new AppError("Cannot process payment for this booking", 400, {
      code: "PAYMENT_TERMINAL_BOOKING",
      retryable: false,
    });
  }
}

function assertStatus(booking, allowedStatuses, actionLabel) {
  if (!allowedStatuses.includes(booking.status)) {
    throw new AppError(
      `Cannot ${actionLabel} while booking status is '${booking.status}'.`,
      400,
      {
        code: "INVALID_BOOKING_STATUS",
        userTip: "Check the booking lifecycle and try the correct next step.",
        retryable: false,
      }
    );
  }
}

function assertPaymentStatus(booking, allowedPaymentStatuses, actionLabel) {
  if (!allowedPaymentStatuses.includes(booking.paymentStatus)) {
    throw new AppError(
      `Cannot ${actionLabel} while paymentStatus is '${booking.paymentStatus}'.`,
      400,
      {
        code: "INVALID_PAYMENT_STATUS",
        userTip: "Complete the required payment step first.",
        retryable: false,
      }
    );
  }
}

function withStatusMessage(bookingLike) {
  const obj = bookingLike && typeof bookingLike.toObject === "function" ? bookingLike.toObject() : bookingLike;
  if (!obj) return obj;
  return {
    ...obj,
    statusMessage: STATUS_MESSAGE_MAP[obj.status] || "Status updated",
  };
}

/** Mongo duplicate key on partial unique index `farmer_one_active_booking`. */
function isFarmerActiveBookingDuplicateKey(err) {
  if (!err) return false;
  const candidates = [];
  candidates.push(err);
  if (err.cause) candidates.push(err.cause);
  if (Array.isArray(err.writeErrors)) {
    for (const we of err.writeErrors) {
      if (we && we.err) candidates.push(we.err);
      else candidates.push(we);
    }
  }
  for (const dup of candidates) {
    if (!dup || (dup.code !== 11000 && dup.code !== 11001)) continue;
    if (dup.keyPattern && Object.prototype.hasOwnProperty.call(dup.keyPattern, "farmer")) return true;
    if (dup.keyValue && Object.prototype.hasOwnProperty.call(dup.keyValue, "farmer")) return true;
    const msg = String(dup.message || err.message || "");
    if (/dup key/i.test(msg) && /farmer/i.test(msg)) return true;
  }
  return false;
}

/** Mongo duplicate key on partial unique index `machine_slot_unique_active` (tractor + date + time). */
function isMachineSlotBookingDuplicateKey(err) {
  if (!err) return false;
  const candidates = [];
  candidates.push(err);
  if (err.cause) candidates.push(err.cause);
  if (Array.isArray(err.writeErrors)) {
    for (const we of err.writeErrors) {
      if (we && we.err) candidates.push(we.err);
      else candidates.push(we);
    }
  }
  for (const dup of candidates) {
    if (!dup || (dup.code !== 11000 && dup.code !== 11001)) continue;
    const kp = dup.keyPattern || {};
    if (kp.tractor && kp.date && kp.time) return true;
    const kv = dup.keyValue || {};
    if (kv.tractor != null && kv.date != null && kv.time != null) return true;
    const msg = String(dup.message || err.message || "");
    if (/machine_slot_unique_active/i.test(msg)) return true;
    if (/dup key/i.test(msg) && /tractor/i.test(msg) && /time/i.test(msg)) return true;
  }
  return false;
}

async function payAdvance(req, res, next) {
  let paymentLock = null;
  let paymentLockKey = "";
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can pay advance for a booking.");
    }
    if (!isPaymentsEnabled()) {
      return next(
        new AppError("Payments are disabled.", 503, {
          code: "PAYMENTS_DISABLED",
          userTip: "Payments are temporarily unavailable.",
          retryable: true,
        })
      );
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const paymentMethod = req.body?.paymentMethod;
    const transactionId =
      req.body?.transactionId != null ? String(req.body.transactionId).trim() : "";
    if (!paymentMethod) {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }
    if (paymentMethod === "cash") {
      res.status(400);
      throw new Error("Cash payments are not supported");
    }
    if (paymentMethod !== "upi") {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }

    const orderId =
      req.body?.orderId != null ? String(req.body.orderId).trim() : "";
    const paymentId =
      req.body?.paymentId != null ? String(req.body.paymentId).trim() : "";
    const enforceWalletGuardEarly =
      String(process.env.ENABLE_WALLET_BALANCE_GUARD || "").trim().toLowerCase() === "true";
    if (enforceWalletGuardEarly) {
      const walletBooking = await Booking.findById(id).lean();
      if (!walletBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!walletBooking.farmer || String(walletBooking.farmer) !== String(req.user._id)) {
        res.status(403);
        throw new Error("You can only pay advance for your own bookings.");
      }
      const requiredAdvanceEarly = Number(walletBooking.advanceAmount || walletBooking.advancePayment || 0);
      const walletEarly = req.user?.wallet;
      if (walletEarly === undefined || walletEarly === null) {
        throw new AppError("Wallet not initialized", 500);
      }
      const walletBalanceEarly = Number(walletEarly);
      if (!Number.isFinite(walletBalanceEarly)) {
        throw new AppError("Wallet not initialized", 500);
      }
      if (walletBalanceEarly < requiredAdvanceEarly) {
        const hasStateFields = typeof walletBooking.status === "string" && typeof walletBooking.paymentStatus === "string";
        const isAlreadyMovedPastAdvanceDue =
          hasStateFields &&
          (walletBooking.status !== "accepted" || walletBooking.paymentStatus !== "advance_due");
        if (!isAlreadyMovedPastAdvanceDue) {
          throw new AppError("Insufficient wallet balance", 402);
        }
      }
    }
    logger.info("[EVENT] Payment initiated", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
      action: "payment.start",
      status: "INITIATED",
    });
    // Strict payment-level lock: prevents concurrent processing for same paymentId.
    // Must be released at the end of the request.
    paymentLockKey = paymentId ? `lock:payment:${paymentId}` : "";
    if (paymentLockKey) {
      paymentLock = await acquireLock(paymentLockKey, 30_000);
      if (!paymentLock?.acquired) {
        return res.status(409).json({ success: false, message: "Payment already processing" });
      }
    }

    if (paymentMethod === "upi") {
      const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
      const sigRaw = req.body?.signature ?? req.body?.razorpay_signature;
      const sig = sigRaw != null ? String(sigRaw).trim() : "";
      if (isProduction && (!orderId || !paymentId || !sig)) {
        res.status(400);
        throw new Error("orderId, paymentId and signature are required for UPI payment verification.");
      }
      let vr;
      try {
        vr = await verifyPayment({
          orderId,
          paymentId,
          signature: sig,
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: sig,
        });
      } catch (error) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance", error }),
          action: "payment.failed",
          status: "FAILED",
        });
        logger.error("Payment verification call failed", {
          bookingId: id.toString(),
          paymentStage: "advance",
          message: error?.message || String(error),
        });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
      if (!vr.verified && isProduction) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
          action: "payment.failed",
          status: "FAILED",
          error: "Payment verification failed",
        });
        logger.warn("Payment verification failed", { bookingId: id.toString(), paymentStage: "advance" });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
    }

    // Fetch booking before any payment idempotency/creation logic.
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only pay advance for your own bookings.");
    }
    const shouldEnforceWalletBalance =
      isProduction() || String(process.env.ENABLE_WALLET_BALANCE_GUARD || "").trim().toLowerCase() === "true";
    const requiredAdvance = Number(booking.advanceAmount || booking.advancePayment || 0);
    // Disallow payments for terminal booking states (cancelled/closed/rejected).
    assertPaymentNotTerminal(booking);

    // Prevent re-use of a paymentId across different bookings (best-effort integrity check).
    if (paymentId) {
      const reused = await isPaymentIdReused(paymentId, booking._id);
      if (reused) {
        logger.warn("PaymentId reuse detected (advance)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Invalid payment reference.");
      }
    }

    // Idempotency: if payment already exists for this booking+type, return it.
    // IMPORTANT: treat PENDING as already-created to prevent duplicate processing.
    const existingPayment = await Payment.findOne({
      bookingId: id,
      type: "advance",
      status: { $in: ["PENDING", "SUCCESS"] },
    }).lean();
    if (existingPayment) {
      const latestBooking = await Booking.findById(id).lean();
      if (!latestBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
        res.status(403);
        throw new Error("You can only pay advance for your own bookings.");
      }
      assertPaymentNotTerminal(latestBooking);

      return sendSuccess(res, 200, "Advance payment already recorded.", {
        booking: withStatusMessage(latestBooking),
        payment: existingPayment,
      });
    }

    if (shouldEnforceWalletBalance) {
      const walletValue = req.user?.wallet;
      if (walletValue === undefined || walletValue === null) {
        throw new AppError("Wallet not initialized", 500);
      }
      const walletBalance = Number(walletValue);
      if (!Number.isFinite(walletBalance)) {
        throw new AppError("Wallet not initialized", 500);
      }
      if (walletBalance < requiredAdvance) {
        throw new AppError("Insufficient wallet balance", 402);
      }
    }

    const session = await mongoose.startSession();
    let updatedBooking;
    let payment;
    const lockKey = `lock:payment:advance:${String(id)}`;
    const lock = await acquireLock(lockKey, 30_000);
    if (!lock.acquired && isProduction()) {
      res.status(409);
      throw new Error("Payment is already being processed. Please retry.");
    }
    if (!lock.acquired && !isProduction()) {
      logger.warn("[lock] payAdvance lock contention (dev continues)", { bookingId: String(id) });
    }
    try {
      await session.withTransaction(async () => {
        const row = await Booking.findOne({
          _id: id,
          farmer: req.user._id,
          status: "accepted",
          paymentStatus: "advance_due",
        }).session(session);

        if (!row) {
          const err = new Error("BOOKING_PAY_TX_NO_MATCH");
          err.code = "BOOKING_PAY_TX_NO_MATCH";
          throw err;
        }

        const advanceAmt = Number(row.advanceAmount || row.advancePayment || 0);
        if (!Number.isFinite(advanceAmt) || advanceAmt <= 0) {
          const err = new Error("BOOKING_PAY_TX_BAD_ADVANCE");
          err.code = "BOOKING_PAY_TX_BAD_ADVANCE";
          throw err;
        }

        if (shouldEnforceWalletBalance) {
          const walletDebit = await User.findOneAndUpdate(
            {
              _id: req.user._id,
              wallet: { $gte: advanceAmt },
            },
            {
              $inc: { wallet: -advanceAmt },
            },
            { new: true, session }
          );
          if (!walletDebit) {
            const err = new Error("BOOKING_PAY_TX_WALLET_DEBIT_FAILED");
            err.code = "BOOKING_PAY_TX_WALLET_DEBIT_FAILED";
            throw err;
          }
        }

        const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
        const isProduction = nodeEnv === "production";
        const skipRazorpayAmountVerification = !isProduction;

        if (!skipRazorpayAmountVerification) {
          // Amount integrity (always enforced server-side):
          // Compare server-calculated expected amount with Razorpay payment amount.
          const fetched = await fetchPaymentAmountRupees(paymentId);
          if (!fetched.ok) {
            const err = new Error("BOOKING_PAY_TX_RZP_FETCH_FAILED");
            err.code = "BOOKING_PAY_TX_RZP_FETCH_FAILED";
            throw err;
          }
          const expected = Number(advanceAmt);
          const actual = Number(fetched.amountRupees);
          if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01) {
            const err = new Error("BOOKING_PAY_TX_AMOUNT_MISMATCH");
            err.code = "BOOKING_PAY_TX_AMOUNT_MISMATCH";
            err.meta = { expected, actual };
            throw err;
          }
        } else {
          logger.warn("DEV MODE: Skipping Razorpay advance amount verification", {
            bookingId: id.toString(),
            paymentStage: "advance",
          });
        }

        const [createdPayment] = await Payment.create(
          [
            {
              bookingId: row._id,
              userId: req.user._id,
              amount: advanceAmt,
              type: "advance",
              status: "PENDING",
              paymentMethod,
              transactionId,
              orderId,
              paymentId,
              walletDebitedAt: shouldEnforceWalletBalance ? new Date() : null,
            },
          ],
          { session }
        );
        payment = createdPayment;

        // Do NOT confirm before webhook success.
        assertBookingTransition("accepted", "payment_pending", "record advance payment");
        const lockExpiresAt = new Date(Date.now() + PAYMENT_PENDING_TTL_MS);
        const upd = await Booking.findOneAndUpdate(
          { _id: id, farmer: req.user._id, status: "accepted", paymentStatus: "advance_due" },
          { $set: { paymentStatus: "advance_paid", status: "payment_pending", lockExpiresAt } },
          { returnDocument: "after", session }
        );

        if (!upd) {
          const err = new Error("BOOKING_PAY_TX_RACE");
          err.code = "BOOKING_PAY_TX_RACE";
          throw err;
        }
        updatedBooking = upd;
      });
    } catch (e) {
      if (e && (e.code === 11000 || e.code === 11001)) {
        payment = await Payment.findOne({
          bookingId: id,
          type: "advance",
          status: { $in: ["PENDING", "SUCCESS"] },
        }).lean();
        if (payment) {
          const latestBooking = await Booking.findById(id).lean();
          if (!latestBooking) {
            res.status(404);
            throw new Error("Booking not found.");
          }
          if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
            res.status(403);
            throw new Error("You can only pay advance for your own bookings.");
          }
          assertPaymentNotTerminal(latestBooking);
          return sendSuccess(res, 200, "Advance payment already recorded.", {
            booking: withStatusMessage(latestBooking),
            payment,
          });
        }
      }

      const retryPayment = await Payment.findOne({
        bookingId: id,
        type: "advance",
        status: { $in: ["PENDING", "SUCCESS"] },
      }).lean();
      if (retryPayment) {
        const latestBooking = await Booking.findById(id).lean();
        if (!latestBooking) {
          res.status(404);
          throw new Error("Booking not found.");
        }
        if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
          res.status(403);
          throw new Error("You can only pay advance for your own bookings.");
        }
        assertPaymentNotTerminal(latestBooking);
        return sendSuccess(res, 200, "Advance payment already recorded.", {
          booking: withStatusMessage(latestBooking),
          payment: retryPayment,
        });
      }

      if (e && e.code === "BOOKING_PAY_TX_AMOUNT_MISMATCH") {
        logger.warn("Advance payment amount mismatch", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment amount mismatch.");
      }
      if (e && e.code === "BOOKING_PAY_TX_RZP_FETCH_FAILED") {
        logger.warn("Razorpay payment fetch failed (advance)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment verification failed.");
      }
      if (e && e.code === "BOOKING_PAY_TX_BAD_ADVANCE") {
        res.status(400);
        throw new Error("Advance amount is not available for this booking.");
      }
      if (e && e.code === "BOOKING_PAY_TX_WALLET_DEBIT_FAILED") {
        throw new AppError("Insufficient wallet balance", 402);
      }
      if (
        e &&
        (e.code === "BOOKING_PAY_TX_NO_MATCH" ||
          e.code === "BOOKING_PAY_TX_RACE" ||
          e.code === 11000 ||
          e.code === 11001)
      ) {
        res.status(400);
        throw new Error("Cannot process payment for this booking");
      }
      throw e;
    } finally {
      session.endSession();
      try {
        await releaseLock(lockKey, lock.token);
      } catch {
        // ignore
      }
    }

    if (!payment || !updatedBooking) {
      res.status(400);
      throw new Error("Cannot process payment for this booking");
    }

    logger.info("[EVENT] Payment recorded (awaiting webhook confirmation)", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: id.toString(),
      amount: Number(payment?.amount) || 0,
      paymentType: "advance",
      paymentId: paymentId || null,
      idempotencyKey: req.get("Idempotency-Key") || null,
      action: "payment.create",
      status: "PENDING",
      timestamp: new Date().toISOString(),
    });
    logger.info("[EVENT] Payment initiated, awaiting verification", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
      action: "payment.awaiting_verification",
      status: "PENDING",
    });
    void logAuditAction(req.user?._id, "PAYMENT_ADVANCE_SUCCESS");

    await logPaymentSuccess({
      userId: req.user._id,
      bookingId: updatedBooking._id,
      amount: payment?.amount ?? 0,
      ledgerKey: payment?._id ? `payment:${payment._id}` : undefined,
    });

    await notifyAdvanceReceived(req, updatedBooking.operator, updatedBooking._id);
    schedulePaymentRecoveryCheck({ paymentId, bookingId: id });
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.farmer,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });

    return sendSuccess(res, 200, "Advance payment recorded successfully.", {
      booking: withStatusMessage(updatedBooking),
      payment,
      paymentPending: true,
    });
  } catch (error) {
    logger.error("[EVENT] Payment failed", {
      ...buildPaymentLogContext({
        req,
        bookingId: req?.params?.id,
        paymentId: req?.body?.paymentId != null ? String(req.body.paymentId).trim() : "",
        stage: "advance",
        error,
      }),
      action: "payment.failed",
      status: "FAILED",
    });
    return next(error);
  } finally {
    // Best-effort release of strict payment lock
    try {
      if (typeof paymentLockKey === "string" && paymentLockKey && paymentLock?.token) {
        await releaseLock(paymentLockKey, paymentLock.token);
      }
    } catch {
      // ignore
    }
  }
}

async function payRemaining(req, res, next) {
  let paymentLock = null;
  let paymentLockKey = "";
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can pay the remaining amount.");
    }
    if (!isPaymentsEnabled()) {
      return next(
        new AppError("Payments are disabled.", 503, {
          code: "PAYMENTS_DISABLED",
          userTip: "Payments are temporarily unavailable.",
          retryable: true,
        })
      );
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const paymentMethod = req.body?.paymentMethod;
    const transactionId =
      req.body?.transactionId != null ? String(req.body.transactionId).trim() : "";
    if (!paymentMethod) {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }
    if (paymentMethod === "cash") {
      res.status(400);
      throw new Error("Cash payments are not supported");
    }
    if (paymentMethod !== "upi") {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }

    const orderId =
      req.body?.orderId != null ? String(req.body.orderId).trim() : "";
    const paymentId =
      req.body?.paymentId != null ? String(req.body.paymentId).trim() : "";
    logger.info("[EVENT] Payment initiated", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
      action: "payment.start",
      status: "INITIATED",
    });
    // Strict payment-level lock: prevents concurrent processing for same paymentId.
    // Must be released at the end of the request.
    paymentLockKey = paymentId ? `lock:payment:${paymentId}` : "";
    if (paymentLockKey) {
      paymentLock = await acquireLock(paymentLockKey, 30_000);
      if (!paymentLock?.acquired) {
        return res.status(409).json({ success: false, message: "Payment already processing" });
      }
    }

    if (paymentMethod === "upi") {
      const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
      const sigRaw = req.body?.signature ?? req.body?.razorpay_signature;
      const sig = sigRaw != null ? String(sigRaw).trim() : "";
      if (isProduction && (!orderId || !paymentId || !sig)) {
        res.status(400);
        throw new Error("orderId, paymentId and signature are required for UPI payment verification.");
      }
      let vr;
      try {
        vr = await verifyPayment({
          orderId,
          paymentId,
          signature: sig,
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: sig,
        });
      } catch (error) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining", error }),
          action: "payment.failed",
          status: "FAILED",
        });
        logger.error("Payment verification call failed", {
          bookingId: id.toString(),
          paymentStage: "remaining",
          message: error?.message || String(error),
        });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
      if (!vr.verified && isProduction) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
          action: "payment.failed",
          status: "FAILED",
          error: "Payment verification failed",
        });
        logger.warn("Payment verification failed", { bookingId: id.toString(), paymentStage: "remaining" });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
    }

    // Fetch booking before any payment idempotency/creation logic.
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only pay remaining balance for your own bookings.");
    }
    // Disallow payments for terminal booking states (cancelled/closed/rejected).
    assertPaymentNotTerminal(booking);

    // Prevent re-use of a paymentId across different bookings (best-effort integrity check).
    if (paymentId) {
      const reused = await isPaymentIdReused(paymentId, booking._id);
      if (reused) {
        logger.warn("PaymentId reuse detected (remaining)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Invalid payment reference.");
      }
    }

    // Idempotency: if payment already exists (PENDING or SUCCESS), return it.
    const existingPayment = await Payment.findOne({
      bookingId: id,
      type: "remaining",
      status: { $in: ["PENDING", "SUCCESS"] },
    }).lean();
    if (existingPayment) {
      const latestBooking = await Booking.findById(id).lean();
      if (!latestBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
        res.status(403);
        throw new Error("You can only pay remaining balance for your own bookings.");
      }
      const idempotentPaid =
        latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus);
      if (!idempotentPaid) {
        assertPaymentNotTerminal(latestBooking);
      }
      if (latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus)) {
        await applyBookingSettlementAfterFullPayment(id);
      }
      const settledBooking =
        (await Booking.findById(id).lean()) || latestBooking;

      return sendSuccess(res, 200, "Remaining payment already recorded.", {
        booking: withStatusMessage(settledBooking),
        payment: existingPayment,
      });
    }

    const session = await mongoose.startSession();
    let updatedBooking;
    let payment;
    const lockKey = `lock:payment:remaining:${String(id)}`;
    const lock = await acquireLock(lockKey, 30_000);
    if (!lock.acquired && isProduction()) {
      res.status(409);
      throw new Error("Payment is already being processed. Please retry.");
    }
    if (!lock.acquired && !isProduction()) {
      logger.warn("[lock] payRemaining lock contention (dev continues)", { bookingId: String(id) });
    }
    try {
      await session.withTransaction(async () => {
        const row = await Booking.findOne({
          _id: id,
          farmer: req.user._id,
          status: "completed",
          paymentStatus: "balance_due",
        }).session(session);

        if (!row) {
          const err = new Error("BOOKING_PAY_TX_NO_MATCH");
          err.code = "BOOKING_PAY_TX_NO_MATCH";
          throw err;
        }

        const remainingAmt = Number(row.remainingAmount || 0);
        if (!Number.isFinite(remainingAmt) || remainingAmt <= 0) {
          const err = new Error("BOOKING_PAY_TX_BAD_REMAINING");
          err.code = "BOOKING_PAY_TX_BAD_REMAINING";
          throw err;
        }

        const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
        const isProduction = nodeEnv === "production";
        const skipRazorpayAmountVerification = !isProduction;

        if (!skipRazorpayAmountVerification) {
          // Amount integrity (always enforced server-side):
          // Compare server-calculated expected amount with Razorpay payment amount.
          const fetched = await fetchPaymentAmountRupees(paymentId);
          if (!fetched.ok) {
            const err = new Error("BOOKING_PAY_TX_RZP_FETCH_FAILED");
            err.code = "BOOKING_PAY_TX_RZP_FETCH_FAILED";
            throw err;
          }
          const expected = Number(remainingAmt);
          const actual = Number(fetched.amountRupees);
          if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01) {
            const err = new Error("BOOKING_PAY_TX_AMOUNT_MISMATCH");
            err.code = "BOOKING_PAY_TX_AMOUNT_MISMATCH";
            err.meta = { expected, actual };
            throw err;
          }
        } else {
          logger.warn("DEV MODE: Skipping Razorpay remaining amount verification", {
            bookingId: id.toString(),
            paymentStage: "remaining",
          });
        }

        const [createdPayment] = await Payment.create(
          [
            {
              bookingId: row._id,
              userId: req.user._id,
              amount: remainingAmt,
              type: "remaining",
              status: "PENDING",
              paymentMethod,
              transactionId,
              orderId,
              paymentId,
            },
          ],
          { session }
        );
        payment = createdPayment;

        // Do NOT close before webhook success.
        assertBookingTransition("completed", "payment_pending", "record remaining payment");
        const lockExpiresAt = new Date(Date.now() + PAYMENT_PENDING_TTL_MS);
        const upd = await Booking.findOneAndUpdate(
          { _id: id, farmer: req.user._id, status: "completed", paymentStatus: "balance_due" },
          { $set: { paymentStatus: "fully_paid", status: "payment_pending", lockExpiresAt } },
          { returnDocument: "after", session }
        );

        if (!upd) {
          const err = new Error("BOOKING_PAY_TX_RACE");
          err.code = "BOOKING_PAY_TX_RACE";
          throw err;
        }
        updatedBooking = upd;
      });
    } catch (e) {
      if (e && (e.code === 11000 || e.code === 11001)) {
        payment = await Payment.findOne({
          bookingId: id,
          type: "remaining",
          status: { $in: ["PENDING", "SUCCESS"] },
        }).lean();
        if (payment) {
          const latestBooking = await Booking.findById(id).lean();
          if (!latestBooking) {
            res.status(404);
            throw new Error("Booking not found.");
          }
          if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
            res.status(403);
            throw new Error("You can only pay remaining balance for your own bookings.");
          }
          const idempotentPaidDup =
            latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus);
          if (!idempotentPaidDup) {
            assertPaymentNotTerminal(latestBooking);
          }
          if (latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus)) {
            await applyBookingSettlementAfterFullPayment(id);
          }
          const settledBooking = (await Booking.findById(id).lean()) || latestBooking;

          return sendSuccess(res, 200, "Remaining payment already recorded.", {
            booking: withStatusMessage(settledBooking),
            payment,
          });
        }
      }

      const retryBooking = await Booking.findById(id).lean();
      if (!retryBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }

      const retryPayment = await Payment.findOne({
        bookingId: id,
        type: "remaining",
        status: { $in: ["PENDING", "SUCCESS"] },
      }).lean();
      if (retryPayment) {
        const retryIdempotentPaid =
          retryBooking.status === "closed" && isPaidLikePaymentStatus(retryBooking.paymentStatus);
        if (!retryIdempotentPaid) {
          assertPaymentNotTerminal(retryBooking);
        }
        if (retryBooking.status === "closed" && isPaidLikePaymentStatus(retryBooking.paymentStatus)) {
          await applyBookingSettlementAfterFullPayment(id);
        }
        const settledRetry = (await Booking.findById(id).lean()) || retryBooking;
        return sendSuccess(res, 200, "Remaining payment already recorded.", {
          booking: withStatusMessage(settledRetry),
          payment: retryPayment,
        });
      }

      if (e && e.code === "BOOKING_PAY_TX_AMOUNT_MISMATCH") {
        logger.warn("Remaining payment amount mismatch", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment amount mismatch.");
      }
      if (e && e.code === "BOOKING_PAY_TX_RZP_FETCH_FAILED") {
        logger.warn("Razorpay payment fetch failed (remaining)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment verification failed.");
      }
      if (e && e.code === "BOOKING_PAY_TX_BAD_REMAINING") {
        res.status(400);
        throw new Error("Remaining amount is not available for this booking.");
      }
      if (
        e &&
        (e.code === "BOOKING_PAY_TX_NO_MATCH" ||
          e.code === "BOOKING_PAY_TX_RACE" ||
          e.code === 11000 ||
          e.code === 11001)
      ) {
        assertPaymentNotTerminal(retryBooking);
        res.status(400);
        throw new Error("Cannot process payment for this booking");
      }
      throw e;
    } finally {
      session.endSession();
      try {
        await releaseLock(lockKey, lock.token);
      } catch {
        // ignore
      }
    }

    if (!payment || !updatedBooking) {
      res.status(400);
      throw new Error("Cannot process payment for this booking");
    }

    logger.info("[EVENT] Payment recorded (awaiting webhook confirmation)", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: id.toString(),
      amount: Number(payment?.amount) || 0,
      paymentType: "remaining",
      paymentId: paymentId || null,
      idempotencyKey: req.get("Idempotency-Key") || null,
      action: "payment.create",
      status: "PENDING",
      timestamp: new Date().toISOString(),
    });
    logger.info("[EVENT] Payment initiated, awaiting verification", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
      action: "payment.awaiting_verification",
      status: "PENDING",
    });
    void logAuditAction(req.user?._id, "PAYMENT_REMAINING_SUCCESS");

    await logPaymentSuccess({
      userId: req.user._id,
      bookingId: updatedBooking._id,
      amount: payment?.amount ?? 0,
      ledgerKey: payment?._id ? `payment:${payment._id}` : undefined,
    });

    // Settlement is only valid after webhook-confirmed close.
    const bookingAfterSettlement = await Booking.findById(id).lean();

    schedulePaymentRecoveryCheck({ paymentId, bookingId: id });
    // Notifications: farmer completed, operator received.
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.farmer,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.operator,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });

    return sendSuccess(res, 200, "Remaining payment recorded successfully.", {
      booking: withStatusMessage(bookingAfterSettlement || updatedBooking),
      payment,
      paymentPending: true,
    });
  } catch (error) {
    logger.error("[EVENT] Payment failed", {
      ...buildPaymentLogContext({
        req,
        bookingId: req?.params?.id,
        paymentId: req?.body?.paymentId != null ? String(req.body.paymentId).trim() : "",
        stage: "remaining",
        error,
      }),
      action: "payment.failed",
      status: "FAILED",
    });
    return next(error);
  } finally {
    // Best-effort release of strict payment lock
    try {
      if (typeof paymentLockKey === "string" && paymentLockKey && paymentLock?.token) {
        await releaseLock(paymentLockKey, paymentLock.token);
      }
    } catch {
      // ignore
    }
  }
}

async function getBookingRefundPreview(req, res, next) {
  try {
    if (!["farmer", "operator"].includes(req.user.role)) {
      res.status(403);
      throw new Error("Only farmers or operators can view refund preview.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = String(booking.farmer) === String(req.user._id);
    const isOperator = String(booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only preview refunds for your own bookings.");
    }

    const { refundAmount, penalty } = resolveRefundSnapshot(booking, { actorIsFarmer: isFarmer });

    return sendSuccess(res, 200, "Refund preview.", {
      refundAmount,
      penalty,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  payAdvance,
  payRemaining,
  getBookingRefundPreview
};
