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

async function createBooking(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can create bookings.");
    }

    const {
      operatorId,
      tractorId,
      landArea,
      serviceType,
      date,
      time,
      address,
      baseAmount: _baseAmountInput,
      totalAmount: _totalAmountLegacy,
    } = req.body;

    // New behavior:
    // - If `tractorId` is provided, derive `operatorId` from the tractor.
    // - If `operatorId` is provided (legacy flow), keep existing logic unchanged.
    let resolvedOperatorId = operatorId;
    let resolvedTractorId = tractorId;
    let tractor = null;

    const tractorIdProvided = resolvedTractorId != null && String(resolvedTractorId).trim() !== "";
    const operatorIdProvided = resolvedOperatorId != null && String(resolvedOperatorId).trim() !== "";

    if (tractorIdProvided) {
      if (!mongoose.Types.ObjectId.isValid(resolvedTractorId)) {
        res.status(400);
        throw new Error("tractorId must be a valid ID.");
      }

      tractor = await Tractor.findById(resolvedTractorId).lean();
      if (!tractor) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      if (tractor.isDeleted === true) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      // Requirement: ensure approved + available in tractor-based flow.
      if (tractor.verificationStatus !== "approved" || tractor.isAvailable !== true) {
        res.status(400);
        throw new Error("Selected tractor must be approved and available.");
      }

      // Derive operatorId from tractor.
      resolvedOperatorId = tractor.operatorId;

      // If legacy clients still send operatorId alongside tractorId, ensure they match.
      if (operatorIdProvided && String(resolvedOperatorId) !== String(operatorId)) {
        res.status(400);
        throw new Error("Selected tractor does not belong to selected operator.");
      }
    } else {
      // Legacy operator-based flow expects both operatorId and tractorId for selection.
      if (!operatorIdProvided) {
        res.status(400);
        throw new Error("tractorId or operatorId is required.");
      }
      if (!mongoose.Types.ObjectId.isValid(resolvedOperatorId)) {
        res.status(400);
        throw new Error("operatorId must be a valid ID.");
      }
      if (!resolvedTractorId || !mongoose.Types.ObjectId.isValid(resolvedTractorId)) {
        res.status(400);
        throw new Error("tractorId must be a valid ID.");
      }
    }

    // Reduce farmer input burden:
    // - If landArea isn't provided, fall back to farmer profile.
    // - If still missing, reject the request.
    const landAreaResolved =
      landArea !== undefined && landArea !== null && landArea !== "" ? landArea : req.user.landArea;
    if (landAreaResolved === undefined || landAreaResolved === null || landAreaResolved === "") {
      res.status(400);
      throw new Error("landArea is required (either in body or from farmer profile).");
    }

    const land = Number(landAreaResolved);
    if (!Number.isFinite(land) || land <= 0) {
      res.status(400);
      throw new Error("landArea must be greater than 0.");
    }

    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }

    if (date === undefined || date === null || date === "") {
      res.status(400);
      throw new Error("date is required.");
    }

    const bookingDate = new Date(date);
    if (Number.isNaN(bookingDate.getTime())) {
      res.status(400);
      throw new Error("date must be a valid date.");
    }
    if (bookingDate.getTime() <= Date.now()) {
      res.status(400);
      throw new Error("date must be in the future.");
    }
    if (typeof time !== "string" || !/^\d{1,2}:\d{2}$/.test(time.trim())) {
      res.status(400);
      throw new Error("time is required and must be in HH:mm format.");
    }

    const serviceTypeTrimmed = serviceType.trim();
    const serviceTypeNormalized = serviceTypeTrimmed.toLowerCase();

    const [pricingDoc, activeCommission, seasonalPricing] = await Promise.all([
      getPricingByServiceTypeCached(serviceTypeNormalized, 300),
      getActiveCommissionCached(300),
      SeasonalPricing.findOne({
        serviceType: serviceTypeNormalized,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      })
        .sort({ startDate: -1 })
        .lean(),
    ]);

    const pricingDocEffective = req.serviceConfig?.pricingDoc || pricingDoc || null;
    if (!activeCommission || !Number.isFinite(activeCommission.percentage)) {
      res.status(400);
      throw new Error("Commission is not configured or not active.");
    }

    const commissionPercentage = Number(activeCommission.percentage);

    let baseAmount;
    const typePricePerAcre = Number(req.serviceConfig?.selectedTypePricing?.pricePerAcre || 0);
    const typePricePerHour = Number(req.serviceConfig?.selectedTypePricing?.pricePerHour || 0);
    const servicePricePerAcre = Number(
      req.serviceConfig?.servicePricing?.pricePerAcre || pricingDocEffective?.pricePerAcre || 0
    );
    const servicePricePerHour = Number(
      req.serviceConfig?.servicePricing?.pricePerHour || pricingDocEffective?.pricePerHour || 0
    );
    const pricePerAcre = typePricePerAcre > 0 ? typePricePerAcre : servicePricePerAcre;
    const pricePerHour = typePricePerHour > 0 ? typePricePerHour : servicePricePerHour;

    if (pricePerAcre > 0) {
      baseAmount = round2(pricePerAcre * land);
    } else if (pricePerHour > 0) {
      // Time-based pricing requires `hours` in the request body.
      const hoursRaw = req.body?.hours;
      const hours =
        hoursRaw !== undefined && hoursRaw !== null && hoursRaw !== "" ? Number(hoursRaw) : null;
      if (!Number.isFinite(hours) || hours <= 0) {
        res.status(400);
        throw new Error("Pricing for this serviceType requires `hours` in request body.");
      }
      baseAmount = round2(pricePerHour * hours);
    } else {
      res.status(400);
      throw new Error("Pricing not configured for this service");
    }

    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      res.status(400);
      throw new Error("baseAmount must be a positive number.");
    }

    const seasonalMultiplierRaw = Number(seasonalPricing?.multiplier || 1);
    const seasonalMultiplier =
      Number.isFinite(seasonalMultiplierRaw) && seasonalMultiplierRaw > 0
        ? seasonalMultiplierRaw
        : 1;
    baseAmount = round2(baseAmount * seasonalMultiplier);

    const farmerHasActive = await Booking.exists({
      farmer: req.user._id,
      status: { $in: FARMER_DUPLICATE_BOOKING_STATUSES },
    });
    if (farmerHasActive) {
      throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
        code: userFacing.DUPLICATE_BOOKING.code,
        userTip: userFacing.DUPLICATE_BOOKING.userTip,
        retryable: userFacing.DUPLICATE_BOOKING.retryable,
      });
    }

    const operatorBusy = await Booking.exists({
      operator: resolvedOperatorId,
      status: { $in: OPERATOR_RESPOND_BUSY_STATUSES },
    });
    if (operatorBusy) {
      throw new AppError("Operator is already busy with another booking", 409, {
        code: userFacing.OPERATOR_BUSY.code,
        userTip: userFacing.OPERATOR_BUSY.userTip,
        retryable: userFacing.OPERATOR_BUSY.retryable,
      });
    }

    if (String(resolvedOperatorId) === String(req.user._id)) {
      throw new AppError("You cannot book yourself as the operator.", 400, {
        code: "INVALID_OPERATOR",
        userTip: "Choose a different operator.",
        retryable: false,
      });
    }

    const operator = await User.findById(resolvedOperatorId).select("role");

    if (!operator) {
      res.status(404);
      throw new Error("Operator not found.");
    }

    if (operator.role !== "operator") {
      res.status(400);
      throw new Error("Selected user is not an operator.");
    }

    const eligible = await canOperatorServeBookings(resolvedOperatorId);
    if (!eligible) {
      throw new AppError(
        "This operator is not verified or has no approved tractor available for booking.",
        400,
        {
          code: "OPERATOR_NOT_ELIGIBLE",
          userTip: "Choose another operator from nearby listings.",
          retryable: false,
        }
      );
    }

    // In tractor-based flow we already fetched `tractor`; in operator-based flow we fetch here.
    if (!tractor) {
      tractor = await Tractor.findById(resolvedTractorId).lean();
      if (!tractor) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      if (tractor.isDeleted === true) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
    }
    if (String(tractor.operatorId) !== String(resolvedOperatorId)) {
      res.status(400);
      throw new Error("Selected tractor does not belong to selected operator.");
    }
    if (tractor.verificationStatus !== "approved" || tractor.isAvailable !== true) {
      res.status(400);
      throw new Error("Selected tractor must be approved and available.");
    }

    const tractorServiceCodes = (tractor.machineryTypes || []).map((c) =>
      String(c || "")
        .trim()
        .toLowerCase()
    );
    if (!tractorServiceCodes.includes(serviceTypeNormalized)) {
      res.status(400);
      throw new Error("Invalid or unsupported service type");
    }

    const bookingSubtype =
      typeof req.body?.type === "string" && req.body.type.trim()
        ? req.body.type.trim().toLowerCase()
        : "";
    if (bookingSubtype) {
      const subs = (tractor.machinerySubTypes || []).map((s) =>
        String(s || "")
          .trim()
          .toLowerCase()
      ).filter(Boolean);
      if (subs.length > 0 && !subs.includes(bookingSubtype)) {
        res.status(400);
        throw new Error("Invalid service type");
      }
    }

    const gstAmount = round2(baseAmount * GST_RATE);
    const platformFee = round2(baseAmount * (commissionPercentage / 100));
    const totalAmount = round2(baseAmount + gstAmount + platformFee);

    // Apply active offer discount (if any) on the full total.
    const now = new Date();
    const activeOffer = await Offer.findOne({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    })
      .sort({ startDate: -1 })
      .lean();

    let discountApplied = 0; // stored as percentage
    let discountAmount = 0; // stored as absolute amount
    let finalAmount = totalAmount;
    if (activeOffer) {
      const discountPercentage = Number(activeOffer.discountPercentage);
      if (Number.isFinite(discountPercentage) && discountPercentage > 0) {
        discountApplied = round2(discountPercentage);
        discountAmount = round2((totalAmount * discountApplied) / 100);
        finalAmount = round2(Math.max(0, totalAmount - discountAmount));
      }
    }

    const advanceAmount = round2(finalAmount * ADVANCE_RATE);
    const remainingAmount = round2(finalAmount - advanceAmount);

    const bookingPayload = {
      farmer: req.user._id,
      operator: resolvedOperatorId,
      tractor: resolvedTractorId,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: land,
      serviceType: serviceTypeTrimmed,
      date: bookingDate,
      time: time != null && typeof time === "string" ? time.trim() : "",
      address: address != null && typeof address === "string" ? address.trim() : "",
      baseAmount,
      gstAmount,
      platformFee,
      totalAmount: totalAmount,
      discountApplied,
      discountAmount,
      estimatedAmount: finalAmount,
      finalAmount: finalAmount,
      advancePayment: advanceAmount,
      advanceAmount,
      remainingAmount,
      seasonalMultiplier,
      seasonalPricingId: seasonalPricing?._id || null,
    };

    const booking = await createBookingFlow({
      userId: req.user._id,
      body: {
        resolvedTractorId,
        bookingDate,
        time,
        bookingPayload,
        FARMER_DUPLICATE_BOOKING_STATUSES,
        userFacing,
        isFarmerActiveBookingDuplicateKey,
        isMachineSlotBookingDuplicateKey,
      },
      requestId: req.requestId || null,
    });
    if (!booking || !booking._id) {
      logger.error("[BOOKING_ERROR] createBooking produced no persisted document", {
        tag: "BOOKING_ERROR",
        operation: "createBooking",
        userId: req.user?._id ? String(req.user._id) : null,
      });
      throw new AppError(userFacing.BOOKING_FAILED.message, 500, {
        code: userFacing.BOOKING_FAILED.code,
        userTip: userFacing.BOOKING_FAILED.userTip,
        retryable: userFacing.BOOKING_FAILED.retryable,
      });
    }
    logger.info("[EVENT] Booking created", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: booking._id.toString(),
      paymentId: null,
      action: "booking.create",
      status: "CREATED",
      timestamp: new Date().toISOString(),
    });
    void logAuditAction(req.user?._id, "BOOKING_CREATED");

    await notifyUser({
      req,
      app: null,
      userId: resolvedOperatorId,
      message: "New booking request received.",
      type: "booking",
      title: "New booking request",
      bookingId: booking._id,
    });

    const bookingPopulated = await Booking.findById(booking._id).populate(
      "tractor",
      "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable verificationStatus"
    );

    return sendSuccess(res, 201, "Booking created successfully.", {
      booking: withStatusMessage(bookingPopulated),
      pricingBreakdown: {
        baseAmount: booking.baseAmount,
        gstAmount: booking.gstAmount,
        platformFee: booking.platformFee,
        totalAmount: booking.totalAmount,
        discountApplied: booking.discountApplied,
        discountAmount: booking.discountAmount,
        finalAmount: booking.finalAmount,
        advanceAmount: booking.advanceAmount,
        remainingAmount: booking.remainingAmount,
        // Derived earnings (non-breaking; do not change DB fields)
        operatorEarning: booking.baseAmount,
        platformEarning: booking.platformFee,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function estimateBooking(req, res, next) {
  try {
    const { landArea, serviceType } = req.body || {};
    if (landArea === undefined || landArea === null || landArea === "") {
      res.status(400);
      throw new Error("landArea is required.");
    }
    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }
    const area = Number(landArea);
    if (!Number.isFinite(area) || area <= 0) {
      res.status(400);
      throw new Error("landArea must be a positive number.");
    }

    const serviceTypeTrimmed = serviceType.trim();
    const serviceTypeNormalized = serviceTypeTrimmed.toLowerCase();

    const [pricingDoc, activeCommission, seasonalPricing] = await Promise.all([
      Pricing.findOne({ serviceType: serviceTypeNormalized }).lean(),
      Commission.findOne({ active: true }).sort({ updatedAt: -1 }).lean(),
      SeasonalPricing.findOne({
        serviceType: serviceTypeNormalized,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      })
        .sort({ startDate: -1 })
        .lean(),
    ]);

    const pricingDocEffective = req.serviceConfig?.pricingDoc || pricingDoc || null;
    if (!activeCommission || !Number.isFinite(activeCommission.percentage)) {
      res.status(400);
      throw new Error("Commission is not configured or not active.");
    }

    const commissionPercentage = Number(activeCommission.percentage);

    const typePricePerAcre = Number(req.serviceConfig?.selectedTypePricing?.pricePerAcre || 0);
    const typePricePerHour = Number(req.serviceConfig?.selectedTypePricing?.pricePerHour || 0);
    const servicePricePerAcre = Number(
      req.serviceConfig?.servicePricing?.pricePerAcre || pricingDocEffective?.pricePerAcre || 0
    );
    const servicePricePerHour = Number(
      req.serviceConfig?.servicePricing?.pricePerHour || pricingDocEffective?.pricePerHour || 0
    );
    const pricePerAcre = typePricePerAcre > 0 ? typePricePerAcre : servicePricePerAcre;
    const pricePerHour = typePricePerHour > 0 ? typePricePerHour : servicePricePerHour;

    let baseAmount;
    if (pricePerAcre > 0) {
      baseAmount = round2(pricePerAcre * area);
    } else if (pricePerHour > 0) {
      const hoursRaw = req.body?.hours;
      const hours =
        hoursRaw !== undefined && hoursRaw !== null && hoursRaw !== "" ? Number(hoursRaw) : null;
      if (!Number.isFinite(hours) || hours <= 0) {
        res.status(400);
        throw new Error("Pricing for this serviceType requires `hours` in request body.");
      }
      baseAmount = round2(pricePerHour * hours);
    } else {
      res.status(400);
      throw new Error("Pricing not configured for this service");
    }

    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      res.status(400);
      throw new Error("baseAmount must be a positive number.");
    }

    const seasonalMultiplierRaw = Number(seasonalPricing?.multiplier || 1);
    const seasonalMultiplier =
      Number.isFinite(seasonalMultiplierRaw) && seasonalMultiplierRaw > 0
        ? seasonalMultiplierRaw
        : 1;
    baseAmount = round2(baseAmount * seasonalMultiplier);

    const gst = round2(baseAmount * GST_RATE);
    const platformFee = round2(baseAmount * (commissionPercentage / 100));
    const totalAmount = round2(baseAmount + gst + platformFee);
    return sendSuccess(res, 200, "Booking estimate generated.", {
      baseAmount,
      gst,
      platformFee,
      totalAmount,
      seasonalMultiplier,
      // Derived earnings (non-breaking; do not change DB fields)
      operatorEarning: baseAmount,
      platformEarning: platformFee,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBooking,
  estimateBooking
};
