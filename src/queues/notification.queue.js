let Queue;
let Worker;

const { logger } = require("../utils/logger");
const { createBullConnection } = require("./redis.connection");

const QUEUE_NAME = "notificationQueue";
const DLQ_NAME = "notificationQueueDLQ";

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

async function enqueueNotificationRetryJob(data) {
  const q = getQueue();
  if (!q) return false;
  await q.add("notification.retry", data, {
    removeOnComplete: 5000,
    removeOnFail: 5000,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  });
  return true;
}

let notificationWorker = null;

function startNotificationWorker(processFn) {
  if (process.env.NODE_ENV === "test") return null;
  if (!bullAvailable()) {
    logger.warn("[queue] BullMQ not available; notification worker not started");
    return null;
  }
  const connection = createBullConnection();
  if (!connection) {
    logger.warn("[queue] REDIS_URL not configured; notification worker not started");
    return null;
  }
  if (notificationWorker) return notificationWorker;

  notificationWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (typeof processFn === "function") {
        await processFn(job.data || {});
      }
    },
    {
      connection,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_NOTIFICATION || "10"),
    }
  );

  notificationWorker.on("failed", async (job, err) => {
    logger.error("[queue] Notification job failed", {
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
            logger.error("[queue] Notification DLQ enqueue failed", {
              type: "ALERT",
              severity: "HIGH",
              action: "queue.notification_dlq_enqueue_failed",
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
      logger.error("[queue] Notification failure handler errored", {
        type: "ALERT",
        severity: "HIGH",
        action: "queue.notification_failed_handler_error",
        status: "ERROR",
        timestamp: new Date().toISOString(),
        queue: QUEUE_NAME,
        jobId: job?.id,
        jobName: job?.name,
        message: outerErr?.message || String(outerErr),
      });
    }
  });

  notificationWorker.on("error", (err) => {
    logger.error("[queue] Notification worker error", {
      type: "ALERT",
      severity: "HIGH",
      message: "Notification queue worker crashed/errored",
      action: "queue.notification_worker_error",
      status: "ERROR",
      timestamp: new Date().toISOString(),
      error: err?.message || String(err),
      bookingId: null,
      paymentId: null,
    });
  });

  logger.info("[queue] Notification worker started", { queue: QUEUE_NAME });
  return notificationWorker;
}

module.exports = {
  enqueueNotificationRetryJob,
  startNotificationWorker,
};

