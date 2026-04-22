const cron = require("node-cron");
const Payment = require("../models/payment.model");
const Booking = require("../models/booking.model");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { enqueueReconcilePaymentsJob, reconcilePaymentsOnce } = require("../queues/payment.queue");

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function schedulePaymentReconciliation() {
  if (process.env.NODE_ENV === "test") return;

  // Run every 3 minutes by default; keep it within the requested 2–5 minute window.
  // In non-production environments, this is safe to run but will no-op without Razorpay keys.
  const expr = String(process.env.PAYMENT_RECONCILE_CRON || "*/3 * * * *");

  cron.schedule(expr, async () => {
    try {
      // Filter verified correct — 2026-04-21
      const bookingStuckCutoff = new Date(Date.now() - 10 * 60 * 1000);
      const bookingStuckFilter = {
        status: "payment_pending",
        updatedAt: { $lt: bookingStuckCutoff },
      };
      const count = await Booking.countDocuments(bookingStuckFilter);
      logger.info(`[CronJob: paymentReconciliation] started — matched ${count} records`);
      if (!env.enablePayments) {
        logger.info("[PAYMENT_QUEUE_SKIP] reconciliation cron tick skipped (payments disabled)", {
          tag: "PAYMENT_QUEUE_SKIP",
        });
        return;
      }
      // Avoid noisy loops in dev without keys.
      if (isProduction() && !process.env.RAZORPAY_KEY_ID) {
        logger.warn("[reconcile] Skipping: Razorpay not configured");
        return;
      }
      const enqueued = await enqueueReconcilePaymentsJob();
      if (!enqueued) {
        if (isProduction()) {
          logger.error("[reconcile] Queue unavailable in production (no fallback)");
          return;
        }
        logger.warn("[reconcile] Queue unavailable; running inline reconciliation (dev fallback)");
        await reconcilePaymentsOnce();
      }

      // Business-level monitoring alerts (log-only):
      // - payments stuck in PENDING > 5 min
      // NOTE: this is intentionally lightweight; real alerts should integrate with Sentry/PagerDuty.
      const stuckCutoff = new Date(Date.now() - 15 * 60 * 1000);
      const stuckCount = await Payment.countDocuments({
        status: "PENDING",
        createdAt: { $lt: stuckCutoff },
      });
      if (stuckCount > 0) {
        logger.warn("[monitor] payments stuck in PENDING > 15m", {
          type: "ALERT",
          severity: "HIGH",
          message: "Payments stuck in PENDING > 15 minutes",
          bookingId: null,
          paymentId: null,
          count: stuckCount,
        });
      }

      const bookingStuckCount = await Booking.countDocuments(bookingStuckFilter);
      if (bookingStuckCount > 0) {
        logger.warn("[monitor] bookings stuck in PAYMENT_PENDING > 10m", {
          type: "ALERT",
          severity: "HIGH",
          message: "Bookings stuck in payment_pending > 10 minutes",
          bookingId: null,
          paymentId: null,
          count: bookingStuckCount,
        });
      }
    } catch (err) {
      logger.error("[reconcile] reconciliation tick failed", { message: err?.message || String(err) });
    }
  });

  logger.info("[reconcile] payment reconciliation scheduled", { cron: expr });
}

module.exports = { schedulePaymentReconciliation };

