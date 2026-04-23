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
const { parsePagination } = require("../../utils/pagination");


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

async function respondToBooking(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can respond to bookings.");
    }

    const { id } = req.params;
    const { action } = req.body;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    if (action === undefined || action === null) {
      res.status(400);
      throw new Error("action is required.");
    }

    if (typeof action !== "string") {
      res.status(400);
      throw new Error('action must be a string: "accept" or "reject".');
    }

    const normalized = action.trim().toLowerCase();
    if (!normalized) {
      res.status(400);
      throw new Error('action must be "accept" or "reject".');
    }

    if (!["accept", "reject"].includes(normalized)) {
      res.status(400);
      throw new Error('action must be "accept" or "reject".');
    }

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only respond to bookings assigned to you.");
    }

    assertNotActionBlocked(booking);
    if (booking.status !== "pending") {
      throw new AppError(
        `Cannot accept/reject unless booking status is pending (current: ${booking.status}).`,
        400,
        {
          code: "INVALID_BOOKING_TRANSITION",
          userTip: "This booking is already in progress. Try the correct next step.",
          retryable: false,
        }
      );
    }

    const throwIfNoAtomicMatch = async () => {
      const fresh = await Booking.findById(id);
      if (!fresh) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!fresh.operator.equals(req.user._id)) {
        res.status(403);
        throw new Error("You can only respond to bookings assigned to you.");
      }
      assertNotActionBlocked(fresh);
      if (fresh.status === "pending") {
        throw new AppError(userFacing.BOOKING_FAILED.message, 400, {
          code: userFacing.BOOKING_FAILED.code,
          userTip: userFacing.BOOKING_FAILED.userTip,
          retryable: userFacing.BOOKING_FAILED.retryable,
        });
      }
      throw new AppError(
        `Cannot accept/reject unless booking status is pending (current: ${fresh.status}).`,
        400,
        {
          code: "INVALID_BOOKING_TRANSITION",
          userTip: "This booking is already in progress. Try the correct next step.",
          retryable: false,
        }
      );
    };

    let bookingAfter;

    if (normalized === "accept") {
      const eligible = await canOperatorServeBookings(req.user._id);
      if (!eligible) {
        throw new AppError(
          "You must be verified and have at least one approved, available tractor before accepting bookings.",
          403,
          {
            code: "OPERATOR_NOT_ELIGIBLE",
            userTip: "Complete KYC and tractor verification, then try again.",
            retryable: false,
          }
        );
      }

      const otherBusy = {
        operator: req.user._id,
        _id: { $ne: booking._id },
        status: { $in: OPERATOR_RESPOND_BUSY_STATUSES },
      };

      const operatorBusy = await Booking.exists(otherBusy);
      if (operatorBusy) {
        throw new AppError(userFacing.OPERATOR_BUSY.message, 409, {
          code: userFacing.OPERATOR_BUSY.code,
          userTip: userFacing.OPERATOR_BUSY.userTip,
          retryable: userFacing.OPERATOR_BUSY.retryable,
        });
      }

      const slotTaken = await Booking.exists({
        operator: req.user._id,
        _id: { $ne: booking._id },
        date: booking.date,
        time: booking.time,
        status: { $in: OPERATOR_RESPOND_BUSY_STATUSES },
      });
      if (slotTaken) {
        throw new AppError(userFacing.SLOT_TAKEN.message, 409, {
          code: userFacing.SLOT_TAKEN.code,
          userTip: userFacing.SLOT_TAKEN.userTip,
          retryable: userFacing.SLOT_TAKEN.retryable,
        });
      }

      const now = new Date();
      const acceptSet = {
        status: "accepted",
        respondedAt: now,
        acceptedAt: now,
      };
      if (booking.paymentStatus === "no_payment") {
        acceptSet.paymentStatus = "advance_due";
      }

      assertBookingTransition("pending", "accepted", "accept booking");
      logStatusTransition({
        event: "[BOOKING_TRANSITION] operator accept",
        bookingId: booking._id,
        userId: req.user?._id,
        before: { status: booking.status },
        after: { status: "accepted" },
      });

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          // Atomic global operator guard (as requested): prevent accepting when operator has an active booking.
          const existingActive = await Booking.findOne({
            operator: req.user._id,
            _id: { $ne: booking._id },
            status: { $in: ["accepted", "in_progress"] },
          })
            .session(session)
            .lean();
          if (existingActive) {
            const err = new Error("Operator already has active booking");
            err.code = "OPERATOR_ALREADY_ACTIVE";
            throw err;
          }

          bookingAfter = await Booking.findOneAndUpdate(
            {
              _id: booking._id,
              operator: req.user._id,
              status: "pending",
            },
            { $set: acceptSet },
            { returnDocument: "after", session }
          );

          if (!bookingAfter) {
            const err = new Error("Booking already accepted");
            err.code = "BOOKING_ALREADY_ACCEPTED";
            throw err;
          }
        });
      } catch (txErr) {
        if (txErr?.code === "OPERATOR_ALREADY_ACTIVE") {
          res.status(409);
          throw new Error("Operator already has active booking");
        }
        if (txErr?.code === "BOOKING_ALREADY_ACCEPTED") {
          res.status(409);
          throw new Error("Booking already accepted");
        }
        throw txErr;
      } finally {
        await session.endSession();
      }

      logger.info("[EVENT] Booking accepted", {
        type: "BOOKING",
        action: "booking.accept",
        status: "ACCEPTED",
        timestamp: new Date().toISOString(),
        requestId: req.requestId || null,
        userId: req.user?._id ? String(req.user._id) : null,
        bookingId: bookingAfter?._id ? String(bookingAfter._id) : null,
        paymentId: null,
      });

      await notifyUser({
        req,
        app: null,
        userId: bookingAfter.farmer,
        message: "Your booking was accepted by the operator.",
        type: "booking",
        title: "Booking accepted",
        bookingId: bookingAfter._id,
      });
    } else {
      const now = new Date();
      assertBookingTransition("pending", "rejected", "reject booking");
      bookingAfter = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          operator: req.user._id,
          status: "pending",
        },
        { $set: { status: "rejected", respondedAt: now } },
        { returnDocument: "after" }
      );

      if (!bookingAfter) {
        await throwIfNoAtomicMatch();
      }
      await notifyUser({
        req,
        app: null,
        userId: bookingAfter.farmer,
        message: "Your booking was rejected by the operator.",
        type: "booking",
        title: "Booking rejected",
        bookingId: bookingAfter._id,
      });
    }

    return sendSuccess(
      res,
      200,
      normalized === "accept" ? "Booking accepted successfully." : "Booking rejected successfully.",
      { booking: withStatusMessage(bookingAfter) }
    );
  } catch (error) {
    return next(error);
  }
}

async function startJob(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can start a job.");
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const phaseRaw = req.body?.phase;
    const phase =
      typeof phaseRaw === "string" ? phaseRaw.trim().toLowerCase() : "start";

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only start jobs for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["confirmed", "en_route"], "start job");
    assertPaymentStatus(booking, ["advance_paid"], "start job");

    if (phase === "en_route") {
      throw new AppError(
        "en_route is not allowed in the production booking lifecycle. Use phase 'start' to move to in_progress.",
        400,
        { code: "INVALID_BOOKING_TRANSITION", retryable: false }
      );
    }

    booking.status = "in_progress";
    booking.startTime = new Date();
    // Initialize job progress for the new lifecycle fields.
    booking.progress = 0;
    booking.progressImages = [];

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "The operator has started the job.",
      type: "job",
      title: "Job started",
      bookingId: booking._id,
    });

    await booking.save();
    logger.info(`[EVENT] Job started: ${booking._id.toString()}`);

    return sendSuccess(res, 200, "Job started successfully.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

async function completeJob(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can complete a job.");
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only complete jobs for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["in_progress"], "complete job");
    assertPaymentStatus(booking, ["advance_paid"], "complete job");

    if (!booking.startTime) {
      res.status(400);
      throw new Error("Cannot complete job before it has been started.");
    }

    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    // Mark completion progress (do not finalize payment here; existing flow remains unchanged).
    booking.progress = 100;
    if (req.body?.finalAmount !== undefined && req.body?.finalAmount !== null && req.body?.finalAmount !== "") {
      const finalAmount = Number(req.body.finalAmount);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        res.status(400);
        throw new Error("finalAmount must be a positive number.");
      }
      booking.finalAmount = finalAmount;
      booking.priceDifferenceReason =
        typeof req.body?.priceDifferenceReason === "string" ? req.body.priceDifferenceReason.trim() : "";
      booking.remainingAmount = round2(Math.max(0, finalAmount - (booking.advanceAmount || 0)));
    }
    booking.endTime = new Date();
    await booking.save();
    logger.info(`[EVENT] Job completed: ${booking._id.toString()}`);

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "Job completed. Please pay remaining amount",
      type: "job",
      title: "Job completed",
      bookingId: booking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "Payment pending: please complete the remaining balance.",
      type: "payment",
      title: "Payment pending",
      bookingId: booking._id,
    });

    return sendSuccess(res, 200, "Job completed successfully.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateBookingProgress(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update job progress.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only update progress for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["in_progress"], "update progress");

    // Multipart form-data often sends numeric fields as strings.
    // Convert safely so subsequent validations/guards work consistently.
    if (typeof req.body?.progress === "string") {
      req.body.progress = Number(req.body.progress);
    }

    const progressRaw = req.body?.progress;
    const progress =
      typeof progressRaw === "number" ? progressRaw : Number(progressRaw);

    if (!Number.isFinite(progress)) {
      res.status(400);
      throw new Error("progress must be a valid number.");
    }

    booking.progress = progress;

    const fs = require("fs");
    const path = require("path");

    const normalizeBodyImages = (images) => {
      if (images == null) return [];
      return Array.isArray(images) ? images : [images];
    };

    const getFileInputsFromReqFiles = (files) => {
      if (!files) return [];
      if (Array.isArray(files)) return files;
      if (typeof files !== "object") return [];
      // Typical multer shape: { images: [file, file] }.
      return Object.values(files).flatMap((v) => {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        return [v];
      });
    };

    const bodyInputs = normalizeBodyImages(req.body?.images);
    const fileInputs = getFileInputsFromReqFiles(req.files);

    const combinedInputs = [...fileInputs, ...bodyInputs].slice(0, 5);
    const nonEmptyInputs = combinedInputs.filter((x) => x != null);

    let successfulUrls = [];
    let allImagesUploadedOrResolved = true;

    const resolveImageInputToUrl = async (img) => {
      // Direct URL string
      if (typeof img === "string") {
        const s = img.trim();
        return s ? s : "";
      }

      // { url: "..." }
      if (img && typeof img === "object" && typeof img.url === "string") {
        const s = img.url.trim();
        return s ? s : "";
      }

      // Multer memory: { buffer, originalname, mimetype }
      if (img && typeof img === "object" && Buffer.isBuffer(img.buffer)) {
        const uploadedUrl = await resolveDocumentInput(img);
        return typeof uploadedUrl === "string" ? uploadedUrl : "";
      }

      // Multer disk: { path, originalname, mimetype }
      if (img && typeof img === "object" && typeof img.path === "string" && img.path) {
        const buffer = await fs.promises.readFile(img.path);
        const originalname =
          typeof img.originalname === "string" && img.originalname.trim()
            ? img.originalname.trim()
            : path.basename(img.path);
        const mimetype =
          typeof img.mimetype === "string" && img.mimetype.trim()
            ? img.mimetype.trim()
            : "application/octet-stream";

        const uploaded = await uploadFile({ buffer, originalname, mimetype });
        return uploaded?.url || "";
      }

      return "";
    };

    if (nonEmptyInputs.length > 0) {
      await Promise.all(
        nonEmptyInputs.map(async (img) => {
          try {
            const url = await resolveImageInputToUrl(img);
            const normalized = typeof url === "string" ? url.trim() : "";
            if (normalized) {
              successfulUrls.push(normalized);
            } else {
              allImagesUploadedOrResolved = false;
            }
          } catch (e) {
            allImagesUploadedOrResolved = false;
            logger.error(`[ERROR] Progress image upload failed: bookingId=${booking._id}`, {
              error: e?.message || String(e),
            });
          }
        })
      );

      // Partial success: store only successfully uploaded URLs.
      if (successfulUrls.length > 0) {
        booking.progressImages = successfulUrls.slice(0, 5);
      }
    }

    await booking.save();

    // Best-effort: notify farmer about progress update.
    try {
      await notifyUser({
        req,
        app: null,
        userId: booking.farmer,
        message: `Operator updated job progress to ${progress}%.`,
        type: "job",
        title: "Job progress updated",
        bookingId: booking._id,
      });
    } catch {
      // Do not fail the API if notifications fail.
    }

    const imagesUploaded = nonEmptyInputs.length === 0 ? false : allImagesUploadedOrResolved;

    return sendSuccess(res, 200, "Job progress updated successfully.", {
      booking: withStatusMessage(booking),
      progress: booking.progress,
      imagesUploaded,
    });
  } catch (error) {
    return next(error);
  }
}

async function cancelBooking(req, res, next) {
  try {
    if (!["farmer", "operator"].includes(req.user.role)) {
      res.status(403);
      throw new Error("Only farmers or operators can cancel a booking.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const reasonRaw = req.body?.reason;
    const reason = reasonRaw != null && typeof reasonRaw === "string" ? reasonRaw.trim() : "";

    const booking = await Booking.findById(id);
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer.equals(req.user._id);
    const isOperator = booking.operator.equals(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(403);
      throw new Error("You can only cancel bookings you are part of.");
    }

    // Strict cancellation rules.
    if (["completed", "closed"].includes(booking.status)) {
      throw new AppError("Cannot cancel: completed/closed bookings cannot be cancelled.", 400, {
        code: "CANCEL_NOT_ALLOWED",
        userTip: "If you need changes, contact support with your booking id.",
        retryable: false,
      });
    }
    if (["cancelled", "rejected"].includes(booking.status)) {
      throw new AppError(`Cannot cancel: booking is already '${booking.status}'.`, 400, {
        code: "CANCEL_NOT_ALLOWED",
        userTip: "This booking is already in a terminal state.",
        retryable: false,
      });
    }

    const cancelledBy = isFarmer ? "farmer" : "operator";
    let refundStatus = "none";
    let penaltyApplied = false;
    let cancellationReason = reason;

    if (isFarmer) {
      // Farmer cancellation rules
      if (booking.status === "pending") {
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer (no penalty).";
      } else if (booking.status === "accepted") {
        penaltyApplied = true;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer (penalty may apply).";
      } else if (booking.paymentStatus === "advance_paid") {
        // No refund for advance_paid cancellation per policy.
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Advance paid; no refund per policy.";
      } else {
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer.";
      }
    } else {
      // Operator cancellation rules: refund advance (if already paid).
      penaltyApplied = false;
      if (booking.paymentStatus === "advance_paid") {
        refundStatus = "pending";
        cancellationReason = cancellationReason || "Cancelled by operator; advance refund initiated.";
      } else {
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by operator.";
      }
    }

    const { refundAmount, penalty } = resolveRefundSnapshot(booking, { actorIsFarmer: isFarmer });
    booking.refundAmount = refundAmount;
    booking.cancellationCharge = penalty;
    booking.cancelledAt = new Date();

    booking.status = "cancelled";
    booking.cancelledBy = cancelledBy;
    booking.cancellationReason = cancellationReason;
    booking.refundStatus = refundStatus;
    booking.penaltyApplied = penaltyApplied;

    await booking.save();

    logger.info(`[EVENT] Booking cancelled: ${booking._id.toString()}`);

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      type: "alert",
      title: "Booking cancelled",
      message: `Booking was cancelled by ${cancelledBy}.`,
      bookingId: booking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: booking.operator,
      type: "alert",
      title: "Booking cancelled",
      message: `Booking was cancelled by ${cancelledBy}.`,
      bookingId: booking._id,
    });

    return sendSuccess(res, 200, "Booking cancelled.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  respondToBooking,
  startJob,
  completeJob,
  cancelBooking,
  updateBookingProgress,
  __testables: {
    isPaidLikePaymentStatus,
    assertBookingTransition,
    assertNotActionBlocked,
    assertPaymentNotTerminal,
    assertStatus,
    assertPaymentStatus,
    withStatusMessage,
    isFarmerActiveBookingDuplicateKey,
    isMachineSlotBookingDuplicateKey,
    parsePagination,
  }
};
