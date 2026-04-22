let Queue;
let Worker;
const mongoose = require("mongoose");

const Payment = require("../models/payment.model");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { createBullConnection } = require("./redis.connection");
const razorpayStatusService = require("../services/razorpayStatus.service");
const { invokeFinalizeRazorpayPaymentCaptured } = require("../services/paymentFinalizerInvoke.service");
const { acquireLock, releaseLock } = require("../services/redisLock.service");

const QUEUE_NAME = "paymentQueue";
const DLQ_NAME = "paymentQueueDLQ";

/** Only tests or explicit opt-in may assume captured when Razorpay status fetch fails. */
function allowReconcileCapturedFallback() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim();
  if (nodeEnv === "test") return true;
  return String(process.env.ALLOW_RECONCILE_FALLBACK || "").trim().toLowerCase() === "true";
}

async function ensureMongoConnection() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  const uri = String(process.env.MONGO_URI || "").trim();
  if (!uri) return;
  await mongoose.connect(uri);
}

function bullAvailable() {
  try {
    const bullmq = require("bullmq");
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;
    return true;
  } catch {
    return false;
  }
}

function getQueue() {
  if (!bullAvailable()) return null;
  const connection = createBullConnection();
  if (!connection) return null;
  return new Queue(QUEUE_NAME, { connection });
}

function getDlq() {
  if (!bullAvailable()) return null;
  const connection = createBullConnection();
  if (!connection) return null;
  return new Queue(DLQ_NAME, { connection });
}

async function enqueueReconcilePaymentsJob() {
  if (!env.enablePayments) {
    logger.info("[PAYMENT_QUEUE_SKIP] reconcile enqueue skipped (payments disabled)", { tag: "PAYMENT_QUEUE_SKIP" });
    return false;
  }
  const q = getQueue();
  if (!q) return false;
  // Singleton job to avoid piling up reconcile work.
  await q.add(
    "reconcilePayments",
    { triggeredAt: new Date().toISOString() },
    {
      jobId: "reconcilePayments",
      removeOnComplete: 100,
      removeOnFail: 1000,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    }
  );
  return true;
}

async function reconcileOnce() {
  await ensureMongoConnection();
  if (!env.enablePayments) {
    logger.info("[PAYMENT_QUEUE_SKIP] reconcilePaymentsOnce skipped (payments disabled)", { tag: "PAYMENT_QUEUE_SKIP" });
    return { processed: 0, skipped: true };
  }
  const pending = await Payment.find({
    status: "PENDING",
  })
    .select("_id paymentId bookingId status createdAt")
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  if (pending.length === 0) return { processed: 0 };

  logger.info("[reconcile] pending payments scan", {
    count: pending.length,
  });

  let processed = 0;

  for (const p of pending) {
    const paymentId = String(p.paymentId || "").trim();
    if (!paymentId) continue;

    let st = await razorpayStatusService.fetchRazorpayPaymentStatus(paymentId);
    if (!st.ok && allowReconcileCapturedFallback()) {
      logger.warn("[reconcile] Explicit fallback: treating payment as captured (test or ALLOW_RECONCILE_FALLBACK)", {
        paymentId,
        bookingId: p.bookingId ? String(p.bookingId) : null,
      });
      st = { ok: true, status: "captured", raw: null };
    }
    if (!st.ok) {
      logger.warn("[reconcile] Razorpay fetch failed", {
        paymentId,
        bookingId: p.bookingId ? String(p.bookingId) : null,
        message: st.error?.message || String(st.error),
      });
      continue;
    }

    if (st.status === "captured") {
      await invokeFinalizeRazorpayPaymentCaptured({
        paymentId,
        webhookEvent: "reconciliation.payment.captured",
        source: "reconciliation",
      });
      processed += 1;
      continue;
    }

    if (st.status === "failed") {
      await Payment.updateOne({ _id: p._id, status: "PENDING" }, { $set: { status: "FAILED" } });
      logger.info("[reconcile] Payment marked FAILED", {
        paymentId,
        bookingId: p.bookingId ? String(p.bookingId) : null,
      });
      processed += 1;
      continue;
    }
  }

  // Recovery helper: detect SUCCESS payments whose bookings were not promoted (rare edge cases).
  // This re-invokes the same finalizer, which is idempotent and lock-protected.
  const mismatches = await Payment.aggregate([
    { $match: { status: "SUCCESS" } },
    {
      $lookup: {
        from: "bookings",
        localField: "bookingId",
        foreignField: "_id",
        as: "bookingDoc",
      },
    },
    { $unwind: { path: "$bookingDoc", preserveNullAndEmptyArrays: true } },
    {
      $match: {
        $or: [
          { $and: [{ type: "advance" }, { "bookingDoc.status": { $ne: "confirmed" } }] },
          { $and: [{ type: "remaining" }, { "bookingDoc.status": { $ne: "closed" } }] },
        ],
      },
    },
    { $project: { paymentId: 1, type: 1, bookingId: 1, bookingStatus: "$bookingDoc.status" } },
    { $limit: 50 },
  ]);

  if (Array.isArray(mismatches) && mismatches.length > 0) {
    logger.error("[ALERT] Payment-booking mismatches detected", {
      type: "ALERT",
      severity: "HIGH",
      message: "Payment SUCCESS but booking status mismatch; attempting repair",
      count: mismatches.length,
      bookingId: null,
      paymentId: null,
    });
    for (const m of mismatches) {
      const pid = String(m.paymentId || "").trim();
      if (!pid) continue;
      await invokeFinalizeRazorpayPaymentCaptured({
        paymentId: pid,
        webhookEvent: "reconciliation.mismatch_repair",
        source: "reconciliation",
      });
    }
  }

  return { processed };
}

let paymentWorker = null;

function startPaymentWorker() {
  if (process.env.NODE_ENV === "test") return null;
  if (!bullAvailable()) {
    logger.warn("[queue] BullMQ not available; payment worker not started");
    return null;
  }
  const connection = createBullConnection();
  if (!connection) {
    logger.warn("[queue] REDIS_URL not configured; payment worker not started");
    return null;
  }
  if (paymentWorker) return paymentWorker;

  paymentWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== "reconcilePayments") return;

      // Distributed guard: only one worker should reconcile at a time.
      const lock = await acquireLock("lock:payments:reconcile", 60_000);
      if (!lock.acquired) {
        logger.warn("[reconcile] reconcile lock contention (skip)", { jobId: job.id });
        return;
      }
      try {
        await reconcileOnce();
      } finally {
        try {
          await releaseLock("lock:payments:reconcile", lock.token);
        } catch {
          // ignore
        }
      }
    },
    {
      connection,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_PAYMENT || "3"),
    }
  );

  paymentWorker.on("failed", async (job, err) => {
    logger.error("[queue] Payment job failed", {
      queue: QUEUE_NAME,
      jobId: job?.id,
      jobName: job?.name,
      message: err?.message,
    });

    try {
      const attemptsMade = Number(job?.attemptsMade || 0);
      const attemptsTotal = Number(job?.opts?.attempts || 0);
      if (attemptsTotal > 0 && attemptsMade >= attemptsTotal) {
        const dlq = getDlq();
        if (dlq) {
          try {
            await dlq.add(
              job.name,
              {
                originalQueue: QUEUE_NAME,
                payload: job?.data || null,
                error: err?.message || String(err),
                failedAt: new Date().toISOString(),
              },
              { removeOnComplete: 5000, removeOnFail: 5000 }
            );
          } catch (dlqErr) {
            logger.error("[queue] Payment DLQ enqueue failed", {
              type: "ALERT",
              severity: "HIGH",
              action: "queue.payment_dlq_enqueue_failed",
              status: "ERROR",
              timestamp: new Date().toISOString(),
              queue: DLQ_NAME,
              jobName: job?.name,
              jobId: job?.id,
              message: dlqErr?.message || String(dlqErr),
            });
          }
        }
      }
    } catch (outerErr) {
      logger.error("[queue] Payment failure handler errored", {
        type: "ALERT",
        severity: "HIGH",
        action: "queue.payment_failed_handler_error",
        status: "ERROR",
        timestamp: new Date().toISOString(),
        queue: QUEUE_NAME,
        jobId: job?.id,
        jobName: job?.name,
        message: outerErr?.message || String(outerErr),
      });
    }
  });

  paymentWorker.on("error", (err) => {
    logger.error("[queue] Payment worker error", {
      type: "ALERT",
      severity: "HIGH",
      message: "Payment queue worker crashed/errored",
      action: "queue.payment_worker_error",
      status: "ERROR",
      timestamp: new Date().toISOString(),
      error: err?.message || String(err),
      bookingId: null,
      paymentId: null,
    });
  });

  logger.info("[queue] Payment worker started", { queue: QUEUE_NAME });
  return paymentWorker;
}

module.exports = {
  enqueueReconcilePaymentsJob,
  reconcilePaymentsOnce: reconcileOnce,
  startPaymentWorker,
};

