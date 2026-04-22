const cron = require("node-cron");
const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const { logger } = require("../utils/logger");
const { acquireLock, releaseLock } = require("../services/redisLock.service");

const LOCK_TTL_MS = 60_000;
const PAYMENT_PENDING_TTL_MS = 10 * 60 * 1000;

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

async function ensureMongoConnection() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  const uri = String(process.env.MONGO_URI || "").trim();
  if (!uri) return;
  await mongoose.connect(uri);
}

async function expireOnce() {
  await ensureMongoConnection();
  const now = new Date();
  // Filter verified correct — 2026-04-21
  const bookingExpiryFilter = {
    status: "payment_pending",
    lockExpiresAt: { $type: "date", $lt: now },
  };
  const count = await Booking.countDocuments(bookingExpiryFilter);
  logger.info(`[CronJob: bookingPaymentLockExpiry] started — matched ${count} records`);
  const candidates = await Booking.find(bookingExpiryFilter)
    .select("_id farmer operator status lockExpiresAt")
    .limit(50)
    .lean();

  for (const b of candidates) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const row = await Booking.findOne({ _id: b._id, status: "payment_pending" }).session(session);
        if (!row) return;
        if (row.lockExpiresAt && row.lockExpiresAt.getTime() > Date.now()) return;

        // Keep flow non-breaking: cancel and release the slot.
        row.status = "cancelled";
        row.cancelledBy = "system";
        row.cancellationReason = "Payment lock expired (no confirmation within window).";
        row.lockExpiresAt = null;
        await row.save({ session });
      });

      logger.warn("[LOCK_EXPIRED] booking payment_pending expired", {
        type: "ALERT",
        severity: "MEDIUM",
        message: "Booking lock expired; booking cancelled",
        bookingId: String(b._id),
        paymentId: null,
        reason: "lock_expired",
      });
    } catch (e) {
      logger.error("[LOCK_EXPIRED] expiry transaction failed", {
        bookingId: String(b._id),
        message: e?.message || String(e),
      });
    } finally {
      await session.endSession();
    }
  }
}

function scheduleBookingPaymentLockExpiry() {
  if (process.env.NODE_ENV === "test") return;

  cron.schedule("* * * * *", async () => {
    // Leader lock to prevent multi-instance duplicate processing.
    const leader = await acquireLock("lock:cron:booking-payment-lock-expiry", LOCK_TTL_MS);
    if (!leader.acquired) return;
    try {
      await expireOnce();
    } finally {
      try {
        await releaseLock("lock:cron:booking-payment-lock-expiry", leader.token);
      } catch {
        // ignore
      }
    }
  });

  if (!isProduction()) {
    logger.info("[cron] booking payment_pending lock expiry scheduled", {
      ttlMinutes: PAYMENT_PENDING_TTL_MS / 60000,
    });
  }
}

module.exports = { scheduleBookingPaymentLockExpiry, PAYMENT_PENDING_TTL_MS, expireOnce };

