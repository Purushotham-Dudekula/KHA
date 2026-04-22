let Queue;
let Worker;

const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { createBullConnection } = require("./redis.connection");
const { invokeFinalizeRazorpayPaymentCaptured } = require("../services/paymentFinalizerInvoke.service");

const QUEUE_NAME = "webhookQueue";
const DLQ_NAME = "webhookQueueDLQ";

function bullAvailable() {
  try {
    // Lazy require so the app can still boot in environments without node_modules installed yet.
    // (CI/local installs will provide bullmq.)
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

async function enqueueRazorpayWebhookJob({ paymentId, webhookEvent, eventId }) {
  if (!env.enablePayments) {
    logger.warn("[PAYMENT_QUEUE_SKIP] Webhook finalize skipped (payments disabled)", {
      tag: "PAYMENT_QUEUE_SKIP",
      paymentId: paymentId || null,
      eventId: eventId || null,
    });
    return { ok: true, skipped: true };
  }
  const q = getQueue();
  if (!q) {
    // Fallback: process inline (still idempotent).
    return invokeFinalizeRazorpayPaymentCaptured({
      paymentId,
      webhookEvent,
      source: "webhook",
    });
  }
  await q.add(
    "razorpay.payment.captured",
    { paymentId, webhookEvent, eventId },
    {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    }
  );
  return { ok: true, queued: true };
}

let webhookWorker = null;

function startWebhookWorker() {
  if (process.env.NODE_ENV === "test") return null;
  if (!bullAvailable()) {
    logger.warn("[queue] BullMQ not available; webhook worker not started");
    return null;
  }
  const connection = createBullConnection();
  if (!connection) {
    logger.warn("[queue] REDIS_URL not configured; webhook worker not started");
    return null;
  }
  if (webhookWorker) return webhookWorker;

  webhookWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { paymentId, webhookEvent, eventId } = job.data || {};
      if (!env.enablePayments) {
        logger.warn("[PAYMENT_QUEUE_SKIP] Webhook worker job skipped (payments disabled)", {
          tag: "PAYMENT_QUEUE_SKIP",
          paymentId: paymentId || null,
          eventId: eventId || null,
        });
        return;
      }
      logger.info("[queue] Webhook job processing", {
        type: "QUEUE",
        action: "webhook.process",
        status: "START",
        timestamp: new Date().toISOString(),
        queue: QUEUE_NAME,
        jobName: job.name,
        paymentId: paymentId || null,
        webhookEvent: webhookEvent || null,
        eventId: eventId || null,
      });
      await invokeFinalizeRazorpayPaymentCaptured({
        paymentId,
        webhookEvent,
        source: "webhook",
      });
    },
    {
      connection,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_WEBHOOK || "5"),
    }
  );

  webhookWorker.on("failed", async (job, err) => {
    logger.error("[queue] Webhook job failed", {
      type: "ALERT",
      severity: "HIGH",
      action: "queue.webhook_failed",
      status: "FAILED",
      timestamp: new Date().toISOString(),
      queue: QUEUE_NAME,
      jobId: job?.id,
      jobName: job?.name,
      message: err?.message,
      paymentId: job?.data?.paymentId || null,
      bookingId: null,
    });

    // Dead-letter on final failure (best effort).
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
                paymentId: job?.data?.paymentId,
                webhookEvent: job?.data?.webhookEvent,
                error: err?.message || String(err),
                failedAt: new Date().toISOString(),
              },
              { removeOnComplete: 5000, removeOnFail: 5000 }
            );
          } catch (dlqErr) {
            logger.error("[queue] Webhook DLQ enqueue failed", {
              type: "ALERT",
              severity: "HIGH",
              action: "queue.webhook_dlq_enqueue_failed",
              status: "ERROR",
              timestamp: new Date().toISOString(),
              queue: DLQ_NAME,
              jobName: job?.name,
              jobId: job?.id,
              paymentId: job?.data?.paymentId || null,
              message: dlqErr?.message || String(dlqErr),
            });
          }
        }
      }
    } catch (outerErr) {
      logger.error("[queue] Webhook failure handler errored", {
        type: "ALERT",
        severity: "HIGH",
        action: "queue.webhook_failed_handler_error",
        status: "ERROR",
        timestamp: new Date().toISOString(),
        queue: QUEUE_NAME,
        jobId: job?.id,
        jobName: job?.name,
        message: outerErr?.message || String(outerErr),
      });
    }
  });

  webhookWorker.on("error", (err) => {
    logger.error("[queue] Webhook worker error", {
      type: "ALERT",
      severity: "HIGH",
      message: "Webhook queue worker crashed/errored",
      action: "queue.webhook_worker_error",
      status: "ERROR",
      timestamp: new Date().toISOString(),
      error: err?.message || String(err),
      bookingId: null,
      paymentId: null,
    });
  });

  logger.info("[queue] Webhook worker started", { queue: QUEUE_NAME });
  return webhookWorker;
}

module.exports = {
  enqueueRazorpayWebhookJob,
  startWebhookWorker,
};

