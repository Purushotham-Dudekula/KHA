const crypto = require("crypto");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { enqueueRazorpayWebhookJob } = require("../queues/webhook.queue");
const WebhookEvent = require("../models/webhookEvent.model");
const { sendSuccess, sendError } = require("../utils/response");

/**
 * Compare two HMAC-SHA256 hex digests (e.g. Razorpay webhook signature vs computed).
 * Never throws: malformed input or length mismatch returns false.
 * Uses timing-safe comparison only when both sides decode to same-length buffers.
 */
function parseHexDigest(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/i.test(s)) return null;
  try {
    return Buffer.from(s, "hex");
  } catch {
    return null;
  }
}

function timingSafeEqualHex(a, b) {
  const aa = parseHexDigest(a);
  const bb = parseHexDigest(b);
  if (!aa || !bb || aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function computeRazorpayWebhookSignature(rawBodyBuffer, secret) {
  return crypto.createHmac("sha256", String(secret)).update(rawBodyBuffer).digest("hex");
}

function readPaymentIdFromWebhookPayload(payload) {
  // Razorpay: payload.payload.payment.entity.id
  const id = payload?.payload?.payment?.entity?.id;
  return typeof id === "string" ? id.trim() : "";
}

function readRazorpayEventId(payload) {
  // Razorpay top-level event id is typically `id` (e.g., "evt_...")
  const id = payload?.id;
  return typeof id === "string" ? id.trim() : "";
}

async function razorpayWebhook(req, res, next) {
  try {
    const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
    const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
    if (!secret) {
      logger.error("[WEBHOOK] Missing RAZORPAY_WEBHOOK_SECRET");
      return sendError(res, "Webhook not configured", 500);
    }

    const signature = String(req.get("x-razorpay-signature") || "").trim();
    const raw = req.rawBody;
    if (!signature || !raw || !Buffer.isBuffer(raw)) {
      if (isProduction) {
        return res.status(400).json({ message: "Invalid webhook signature" });
      }
      logger.warn("[WEBHOOK] Missing signature or raw body", {
        hasSignature: Boolean(signature),
        hasRawBody: Boolean(raw),
      });
      return sendError(res, "Invalid webhook request", 400);
    }

    const expected = computeRazorpayWebhookSignature(raw, secret);
    const ok = timingSafeEqualHex(signature, expected);
    if (!ok) {
      if (isProduction) {
        return res.status(400).json({ message: "Invalid webhook signature" });
      }
      logger.warn("[WEBHOOK] Signature verification failed", {
        webhook: "razorpay",
      });
      return sendError(res, "Invalid signature", 401);
    }

    const event = typeof req.body?.event === "string" ? req.body.event : null;
    const eventIdRaw = readRazorpayEventId(req.body);
    const paymentId = readPaymentIdFromWebhookPayload(req.body);
    const eventId =
      eventIdRaw ||
      `fallback:${event || "unknown"}:${paymentId || "missing"}:${String(req.body?.created_at || "")}`;

    logger.info("[WEBHOOK] Razorpay received", {
      type: "WEBHOOK",
      action: "razorpay.webhook_received",
      status: "OK",
      timestamp: new Date().toISOString(),
      eventId,
      paymentId: paymentId || null,
      webhookEvent: event,
    });

    // We only act on payment.captured; other events are acknowledged (do not retry storms).
    if (event !== "payment.captured") {
      return sendSuccess(res, null, "Ignored event");
    }
    if (!env.enablePayments) {
      logger.warn("[PAYMENT_WEBHOOK_SKIP] Payments disabled; acknowledging without finalize", {
        tag: "PAYMENT_WEBHOOK_SKIP",
        paymentId: paymentId || null,
        eventId,
      });
      return sendSuccess(res, null, "Ignored event");
    }
    if (!paymentId) {
      return sendError(res, "Missing payment id", 400);
    }

    // Idempotency: atomic upsert prevents duplicate event rows even before unique index builds.
    const dedupe = await WebhookEvent.findOneAndUpdate(
      { provider: "razorpay", eventId },
      {
        $setOnInsert: {
          provider: "razorpay",
          eventId,
          event: String(event || ""),
          paymentId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      { upsert: true, returnDocument: "before" }
    );
    if (dedupe) {
      logger.warn("[WEBHOOK] Duplicate webhook event ignored", {
        type: "ALERT",
        severity: "MEDIUM",
        message: "Duplicate webhook ignored",
        action: "razorpay.webhook_duplicate",
        status: "ALREADY_PROCESSED",
        timestamp: new Date().toISOString(),
        eventId,
        paymentId,
        bookingId: null,
      });
      return sendSuccess(res, null, "Webhook already processed.");
    }

    // Enqueue for async processing. Route stays fast.
    const enqueueResult = await enqueueRazorpayWebhookJob({
      paymentId,
      webhookEvent: event,
      eventId,
    });
    if (enqueueResult && enqueueResult.ok === false) {
      throw new Error(enqueueResult.message || "Webhook processing failed.");
    }

    logger.info("[EVENT] Webhook processed", {
      type: "WEBHOOK",
      action: "webhook.processed",
      status: "PROCESSED",
      eventId,
      paymentId,
      timestamp: new Date().toISOString(),
    });

    return sendSuccess(res, null, "Webhook processed.");
  } catch (error) {
    logger.error("[PAYMENT_WEBHOOK_ERROR] Razorpay webhook handler failed", {
      tag: "PAYMENT_WEBHOOK_ERROR",
      operation: "razorpayWebhook",
      message: error?.message || String(error),
    });
    return next(error);
  }
}

module.exports = { razorpayWebhook };

