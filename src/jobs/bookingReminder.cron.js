const cron = require("node-cron");
const os = require("os");
const Booking = require("../models/booking.model");
const { getBookingScheduledAtMs } = require("../utils/bookingSchedule");
const { notifyUsers, notifyUser } = require("../services/notification.service");
const { logger } = require("../utils/logger");
const { getRedisClient } = require("../services/redis.service");

const REMINDER_WINDOW_MIN = 30;
const MS_WINDOW = 5 * 60 * 1000;
const OPERATOR_RESPONSE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const ADVANCE_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;
const CRON_LOCK_KEY = "lock:cron:booking-reminder";
const CRON_LOCK_TTL_MS = Math.max(30_000, Number(process.env.CRON_LOCK_TTL_MS || 55_000));

async function acquireCronLeaderLock() {
  const redis = getRedisClient();
  // Non-breaking fallback for local/dev single-process setups.
  if (!redis) return { acquired: true, token: null };
  const token = `${os.hostname()}:${process.pid}:${Date.now()}`;
  try {
    const result = await redis.set(CRON_LOCK_KEY, token, "PX", CRON_LOCK_TTL_MS, "NX");
    return { acquired: result === "OK", token };
  } catch (error) {
    logger.warn("Cron leader lock acquire failed, skipping this tick", {
      message: error?.message || String(error),
    });
    return { acquired: false, token: null };
  }
}

async function releaseCronLeaderLock(token) {
  if (!token) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      CRON_LOCK_KEY,
      token
    );
  } catch {
    // Best-effort unlock; TTL expiry will recover.
  }
}

function scheduleBookingReminders(app) {
  // Main reminder/auto-cancel worker
  cron.schedule("* * * * *", async () => {
    const ioApp = app;
    const lock = await acquireCronLeaderLock();
    if (!lock.acquired) {
      return;
    }
    try {
      const now = Date.now();
      const target = now + REMINDER_WINDOW_MIN * 60 * 1000;
      // Target active/pending bookings for reminders and auto-cancellation.
      // Excludes terminal states (completed, cancelled, rejected, closed)
      // to prevent unnecessary processing or erroneous reminders.
      const reminderFilter = {
        status: { $nin: ["completed", "cancelled", "rejected", "closed"] },
      };
      const count = await Booking.countDocuments(reminderFilter);
      logger.info(`[CronJob: bookingReminder] started — matched ${count} records`);
      const bookings = await Booking.find(reminderFilter).lean();

      for (const b of bookings) {
        const ageMs = now - new Date(b.createdAt).getTime();

        // 1) pending -> cancel after 4 hours (operator not responding) — still from creation
        if (b.status === "pending" && ageMs >= OPERATOR_RESPONSE_TIMEOUT_MS) {
          await Booking.updateOne(
            { _id: b._id, status: "pending" },
            {
              $set: {
                status: "cancelled",
                cancelledBy: "system",
                cancellationReason: "Operator did not respond within 4 hours.",
              },
            }
          );
          await notifyUser({
            app: ioApp,
            req: null,
            userId: b.farmer,
            type: "alert",
            title: "Operator not responding",
            message: "Operator not available. Please try another operator.",
            bookingId: b._id,
          });
          await notifyUser({
            app: ioApp,
            req: null,
            userId: b.operator,
            type: "alert",
            title: "Booking auto-cancelled",
            message: "Booking was auto-cancelled due to no response.",
            bookingId: b._id,
          });
          logger.info(
            `[EVENT] Booking auto-cancelled (no operator response): ${b._id.toString()}`
          );
          continue;
        }

        // Advance payment deadline: 30 minutes after operator acceptance (not from booking creation)
        const acceptedAtRaw = b.acceptedAt;
        const msSinceAccept =
          acceptedAtRaw != null ? now - new Date(acceptedAtRaw).getTime() : null;

        // 2) accepted + advance_due -> cancel after 30 minutes from acceptedAt
        if (
          b.status === "accepted" &&
          b.paymentStatus === "advance_due" &&
          msSinceAccept != null &&
          msSinceAccept >= ADVANCE_PAYMENT_TIMEOUT_MS
        ) {
          await Booking.updateOne(
            { _id: b._id, status: "accepted", paymentStatus: "advance_due" },
            {
              $set: {
                status: "cancelled",
                cancelledBy: "system",
                cancellationReason: "Advance payment not received within 30 minutes.",
              },
            }
          );
          await notifyUser({
            app: ioApp,
            req: null,
            userId: b.farmer,
            type: "alert",
            title: "Payment reminder expired",
            message: "Booking auto-cancelled because advance payment was not completed in time.",
            bookingId: b._id,
          });
          await notifyUser({
            app: ioApp,
            req: null,
            userId: b.operator,
            type: "alert",
            title: "Booking auto-cancelled",
            message: "Booking was auto-cancelled due to missing advance payment.",
            bookingId: b._id,
          });
          logger.info(`[EVENT] Booking auto-cancelled (advance timeout): ${b._id.toString()}`);
          continue;
        }

        // 3) payment reminder (accepted + advance_due, window before 30-minute deadline from acceptedAt)
        if (
          b.status === "accepted" &&
          b.paymentStatus === "advance_due" &&
          msSinceAccept != null &&
          msSinceAccept >= ADVANCE_PAYMENT_TIMEOUT_MS - MS_WINDOW &&
          msSinceAccept < ADVANCE_PAYMENT_TIMEOUT_MS
        ) {
          await notifyUser({
            app: ioApp,
            req: null,
            userId: b.farmer,
            type: "alert",
            title: "Payment reminder",
            message: "Please complete advance payment soon to keep your booking active.",
            bookingId: b._id,
          });
        }

        // 4) 30-min pre-job reminder for confirmed bookings
        if (!(b.status === "confirmed" && b.paymentStatus === "advance_paid" && b.jobReminderSent !== true)) {
          continue;
        }

        const scheduled = getBookingScheduledAtMs(b);
        if (scheduled < now) continue;
        if (scheduled < target - MS_WINDOW || scheduled > target + MS_WINDOW) continue;

        const msg = "Job reminder: your booking starts in about 30 minutes.";
        await notifyUsers(ioApp, null, [
          { userId: b.farmer, message: msg, type: "job", title: "Job reminder", bookingId: b._id },
          { userId: b.operator, message: msg, type: "job", title: "Job reminder", bookingId: b._id },
        ]);
        await Booking.updateOne({ _id: b._id }, { $set: { jobReminderSent: true } });
      }
    } catch (err) {
      logger.error(`bookingReminder cron: ${err.message}`);
    } finally {
      await releaseCronLeaderLock(lock.token);
    }
  });
}

module.exports = { scheduleBookingReminders };
