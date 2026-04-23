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

async function listFarmerBookings(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can list farmer bookings.");
    }

    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50 });
    const { status, serviceType } = req.query || {};
    const filter = { farmer: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operator", OPERATOR_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    const active = [];
    const completed = [];
    const cancelled = [];

    const activeStatuses = new Set(["pending", "accepted", "confirmed", "en_route", "in_progress"]);
    const completedStatuses = new Set(["completed", "payment_pending", "closed"]);
    const cancelledStatuses = new Set(["cancelled", "rejected"]);

    for (const b of bookings) {
      const plain = b.toObject();
      if (plain.operator) plain.operator = cleanUserResponse(plain.operator);
      const withMsg = withStatusMessage(plain);
      if (cancelledStatuses.has(b.status)) cancelled.push(withMsg);
      else if (completedStatuses.has(b.status)) completed.push(withMsg);
      else if (activeStatuses.has(b.status)) active.push(withMsg);
      else active.push(withMsg);
    }

    const data = { active, completed, cancelled };

    // Backward compatible: keep original top-level keys, add pagination metadata + `data`.
    return sendSuccess(res, 200, "Farmer bookings fetched.", {
      ...data,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listOperatorBookings(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can list operator bookings.");
    }

    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50 });
    const { status, serviceType } = req.query || {};
    const filter = { operator: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("farmer", FARMER_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    const pending = [];
    const accepted = [];
    const inProgress = [];
    const completed = [];
    const cancelled = [];

    for (const b of bookings) {
      const plain = b.toObject();
      if (plain.farmer) plain.farmer = cleanUserResponse(plain.farmer);
      const withMsg = withStatusMessage(plain);
      if (b.status === "pending") pending.push(withMsg);
      else if (b.status === "accepted" || b.status === "confirmed") accepted.push(withMsg);
      else if (b.status === "en_route" || b.status === "in_progress") inProgress.push(withMsg);
      else if (["completed", "payment_pending", "closed"].includes(b.status)) completed.push(withMsg);
      else if (["cancelled", "rejected"].includes(b.status)) cancelled.push(withMsg);
    }

    const data = {
      pending,
      accepted,
      in_progress: inProgress,
      completed,
      cancelled,
    };

    // Backward compatible: keep original top-level keys, add pagination metadata + `data`.
    return sendSuccess(res, 200, "Operator bookings fetched.", {
      pending,
      accepted,
      in_progress: inProgress,
      completed,
      cancelled,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyFarmerBookings(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can view their booking history.");
    }

    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50 });
    const { status, date, serviceType } = req.query || {};

    const filter = { farmer: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof date === "string" && date.trim()) {
      const parsed = new Date(date.trim());
      if (Number.isNaN(parsed.getTime())) {
        res.status(400);
        throw new Error("Invalid date filter.");
      }
      const start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operator", OPERATOR_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    return sendSuccess(res, 200, "Farmer bookings fetched.", {
      count: bookings.length,
      bookings,
      data: bookings,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyOperatorBookings(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can view their booking history.");
    }

    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50 });
    const { status, date, serviceType } = req.query || {};

    const filter = { operator: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof date === "string" && date.trim()) {
      const parsed = new Date(date.trim());
      if (Number.isNaN(parsed.getTime())) {
        res.status(400);
        throw new Error("Invalid date filter.");
      }
      const start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("farmer", FARMER_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    return sendSuccess(res, 200, "Operator bookings fetched.", {
      count: bookings.length,
      bookings,
      data: bookings,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function getBookingDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id)
      .populate(
        "farmer",
        "name phone village role language landArea primaryCrop soilType isOnline averageRating reviewCount verificationStatus"
      )
      .populate(
        "operator",
        "name phone village role isOnline averageRating reviewCount verificationStatus aadhaarVerified"
      )
      .populate(
        "tractor",
        "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable"
      )
      .lean();

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer && String(booking.farmer._id || booking.farmer) === String(req.user._id);
    const isOperator = booking.operator && String(booking.operator._id || booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only access details for your own bookings.");
    }

    const timestamps = {
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      acceptedAt: booking.acceptedAt,
      respondedAt: booking.respondedAt,
      startTime: booking.startTime,
      endTime: booking.endTime,
    };

    const bookingForResponse = { ...booking };
    applyAdvanceFieldDedupe(bookingForResponse);

    return sendSuccess(res, 200, "Booking details fetched.", {
      booking: bookingForResponse,
      farmer: bookingForResponse.farmer ?? null,
      operator: bookingForResponse.operator ?? null,
      tractor: bookingForResponse.tractor ?? null,
      paymentStatus: bookingForResponse.paymentStatus,
      timestamps,
    });
  } catch (error) {
    return next(error);
  }
}

async function getBookingInvoice(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const wantsDownload = String(req.query?.type || "")
      .trim()
      .toLowerCase() === "download";
    const downloadFilename = `invoice-${id}.pdf`;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const selfDownloadUrl = `${baseUrl}/api/bookings/${id}/invoice?type=download`;

    const isAllowedInvoiceHost = (hostname) => {
      const h = String(hostname || "").toLowerCase();
      if (!h) return false;
      // Cloudinary
      if (h === "res.cloudinary.com") return true;
      // Common S3 patterns
      if (h.endsWith(".amazonaws.com")) return true;
      if (h.endsWith(".s3.amazonaws.com")) return true;
      if (h.includes(".s3.") && h.endsWith(".amazonaws.com")) return true;
      return false;
    };

    const streamFromUrl = async (sourceUrl) => {
      const http = require("http");
      const https = require("https");

      const u = new URL(sourceUrl);
      if (!isAllowedInvoiceHost(u.hostname)) {
        throw new Error("Invoice host is not allowed.");
      }
      const client = u.protocol === "https:" ? https : http;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${downloadFilename}`);

      return new Promise((resolve, reject) => {
        const upstream = client.get(sourceUrl, (upRes) => {
          if (!upRes || upRes.statusCode >= 400) {
            const code = upRes?.statusCode || 502;
            reject(new Error(`Invoice upstream fetch failed (status=${code}).`));
            return;
          }
          upRes.on("error", reject);
          upRes.pipe(res);
          upRes.on("end", resolve);
        });

        upstream.on("error", reject);
      });
    };

    const booking = await Booking.findById(id)
      .populate(
        "farmer",
        "name phone village role language landArea isOnline averageRating reviewCount"
      )
      .populate(
        "operator",
        "name phone village role isOnline averageRating reviewCount"
      )
      .populate(
        "tractor",
        "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable"
      );

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer && String(booking.farmer._id || booking.farmer) === String(req.user._id);
    const isOperator = booking.operator && String(booking.operator._id || booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only access invoices for your own bookings.");
    }

    const existingInvoiceUrl = booking.invoiceUrl && String(booking.invoiceUrl).trim();
    if (existingInvoiceUrl) {
      if (wantsDownload) {
        // Backward compatible direct download:
        // if invoiceUrl exists (stored in booking), stream it directly; do not regenerate.
        if (existingInvoiceUrl !== selfDownloadUrl) {
          // Validate URL reachability before deciding to regenerate.
          let reachable = false;
          try {
            const u = new URL(existingInvoiceUrl);
            if (!isAllowedInvoiceHost(u.hostname)) {
              res.status(400);
              throw new Error("Invoice host is not allowed.");
            }
            const headRes = await fetch(existingInvoiceUrl, { method: "HEAD" });
            reachable = headRes && headRes.status === 200;
          } catch {
            reachable = false;
          }

          if (reachable) {
            try {
              await streamFromUrl(existingInvoiceUrl);
              return;
            } catch (streamErr) {
              logger.error(
                `[ERROR] Invoice download stream failed, fallback to regenerate: bookingId=${id}`,
                { error: streamErr?.message || String(streamErr) }
              );
              // Fall through to regeneration below.
            }
          } else {
            logger.warn("Invoice HEAD check failed, using fallback", { bookingId: id });

            // Do not regenerate yet: attempt streaming the existing URL as fallback.
            try {
              await streamFromUrl(existingInvoiceUrl);
              return;
            } catch {
              // Only now we know we must regenerate.
              logger.warn("Invoice fallback regeneration", {
                bookingId: id,
                reason: "stream failed after HEAD failure",
              });
              // Fall through to existing regeneration logic below.
            }
          }
        }
        // If invoiceUrl points back to this endpoint (fallback URL), regenerate below.
      } else {
        // Default behavior: return JSON with stored invoiceUrl, never regenerate.
        return sendSuccess(res, 200, "Invoice fetched successfully.", {
          invoiceUrl: existingInvoiceUrl,
        });
      }
    }

    const payments = await Payment.find({ bookingId: id, status: "SUCCESS" })
      .select("type amount paymentMethod transactionId createdAt")
      .lean();

    const advance = payments.find((p) => p.type === "advance");
    const remaining = payments.find((p) => p.type === "remaining");
    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Keep existing PDF generation logic.
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", margin: 50 });

    doc.fontSize(18).text("KH Agriconnect — Invoice", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Booking ID: ${id}`);
    doc.text(`Service Type: ${booking.serviceType || "-"}`);
    doc.text(
      `Date: ${booking.date ? new Date(booking.date).toISOString().slice(0, 10) : "-"}`
    );
    doc.text(`Time: ${booking.time || "-"}`);
    if (booking.address) doc.text(`Address: ${booking.address}`);

    doc.moveDown();
    doc.fontSize(14).text("Parties");
    doc.fontSize(12);
    doc.text(`Farmer: ${booking.farmer?.name || "-"} (${booking.farmer?.phone || "-"})`);
    doc.text(
      `Operator: ${booking.operator?.name || "-"} (${booking.operator?.phone || "-"})`
    );

    doc.moveDown();
    doc.fontSize(14).text("Tractor");
    doc.fontSize(12);
    const tractorParts = [
      booking.tractor?.tractorType,
      booking.tractor?.brand,
      booking.tractor?.model,
      booking.tractor?.registrationNumber
        ? `(${booking.tractor.registrationNumber})`
        : "",
    ].filter(Boolean);
    doc.text(`${tractorParts.length ? tractorParts.join(" ") : "-"}`);

    doc.moveDown();
    doc.fontSize(14).text("Payment Summary");
    doc.fontSize(12);
    doc.text(`Advance: ${advance?.amount ?? 0}`);
    doc.text(`Remaining: ${remaining?.amount ?? 0}`);
    doc.text(`Total Paid: ${totalPaid}`);

    doc.moveDown();
    doc.fontSize(14).text("Financial breakdown");
    doc.fontSize(12);
    doc.text(`Total amount: ${Number(booking.totalAmount) || 0}`);
    doc.text(`Platform fee: ${Number(booking.platformFee) || 0}`);
    doc.text(`GST: ${Number(booking.gstAmount) || 0}`);
    doc.text(`Operator earning: ${Number(booking.operatorEarning) || 0}`);

    const createdAtStr = booking.createdAt ? new Date(booking.createdAt).toISOString() : "-";
    doc.moveDown();
    doc.fontSize(10).text(`Generated at: ${createdAtStr}`);

    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.end();
    });

    let storedUrl = "";
    try {
      const uploaded = await uploadFile({
        buffer: pdfBuffer,
        originalname: `invoice-${id}.pdf`,
        mimetype: "application/pdf",
      });
      storedUrl = uploaded?.url || "";
      if (storedUrl) {
        booking.invoiceUrl = storedUrl;
        await booking.save();
      }
    } catch (uploadErr) {
      logger.error(`[ERROR] Invoice upload failed: bookingId=${id}`, {
        error: uploadErr?.message || String(uploadErr),
      });
    }

    if (wantsDownload) {
      // Stream generated PDF directly (works even if storage upload failed).
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${downloadFilename}`);
      res.end(pdfBuffer);
      return;
    }

    // Default: return JSON with invoiceUrl.
    // If storage upload failed, return a self download URL so the client can still download.
    return sendSuccess(res, 200, "Invoice generated successfully.", {
      invoiceUrl: storedUrl || existingInvoiceUrl || selfDownloadUrl,
    });
  } catch (error) {
    return next(error);
  }
}

async function trackBooking(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can track jobs.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id)
      .select("farmer operator")
      .populate("operator", "location")
      .lean();

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only track your own bookings.");
    }

    const opCoords = booking.operator?.location?.coordinates;
    if (!Array.isArray(opCoords) || opCoords.length < 2) {
      return sendSuccess(res, 200, "Operator location not available yet.", {
        operatorLocation: null,
        distanceKm: null,
        estimatedArrivalTime: null,
        routeDistanceKm: null,
        routeDurationMinutes: null,
      });
    }

    const operatorLongitude = Number(opCoords[0]);
    const operatorLatitude = Number(opCoords[1]);

    // Treat [0,0] as "not available" to prevent fake tracking distances.
    if (!Number.isFinite(operatorLatitude) || !Number.isFinite(operatorLongitude) || (operatorLatitude === 0 && operatorLongitude === 0)) {
      return sendSuccess(res, 200, "Operator location not available yet.", {
        operatorLocation: null,
        distanceKm: null,
        estimatedArrivalTime: null,
        routeDistanceKm: null,
        routeDurationMinutes: null,
      });
    }

    const farmerCoords = req.user?.location?.coordinates;
    let distanceKm = null;
    let estimatedArrivalTime = null;
    let routeDistanceKm = null;
    let routeDurationMinutes = null;

    if (Array.isArray(farmerCoords) && farmerCoords.length >= 2) {
      const farmerLongitude = Number(farmerCoords[0]);
      const farmerLatitude = Number(farmerCoords[1]);

      // Treat [0,0] as "not available".
      const farmerCoordsValid =
        Number.isFinite(farmerLatitude) &&
        Number.isFinite(farmerLongitude) &&
        !(farmerLatitude === 0 && farmerLongitude === 0);
      if (
        farmerCoordsValid &&
        Number.isFinite(operatorLatitude) &&
        Number.isFinite(operatorLongitude)
      ) {
        distanceKm = round2(haversineKm(farmerLatitude, farmerLongitude, operatorLatitude, operatorLongitude));

        const route = await getDistanceAndETA(
          { lat: farmerLatitude, lng: farmerLongitude },
          { lat: operatorLatitude, lng: operatorLongitude }
        );
        routeDistanceKm = route.distanceKm;
        routeDurationMinutes = route.durationMinutes;
        estimatedArrivalTime = new Date(Date.now() + route.durationMinutes * 60 * 1000).toISOString();
      }
    }

    return sendSuccess(res, 200, "Tracking info fetched.", {
      operatorLocation: {
        latitude: operatorLatitude,
        longitude: operatorLongitude,
      },
      distanceKm,
      estimatedArrivalTime,
      routeDistanceKm,
      routeDurationMinutes,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getBookingDetails,
  getBookingInvoice,
  listFarmerBookings,
  listOperatorBookings,
  listMyFarmerBookings,
  listMyOperatorBookings,
  trackBooking
};
