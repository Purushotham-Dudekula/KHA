describe("payment.queue coverage boost", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.REDIS_URL;
    delete process.env.ALLOW_RECONCILE_FALLBACK;
  });

  test("enqueueReconcilePaymentsJob returns false when queue unavailable", async () => {
    jest.doMock("../../src/config/env", () => ({ env: { enablePayments: true } }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: jest.fn(() => null) }));
    const q = require("../../src/queues/payment.queue");
    await expect(q.enqueueReconcilePaymentsJob()).resolves.toBe(false);
  });

  test("enqueueReconcilePaymentsJob skips when payments disabled", async () => {
    jest.doMock("../../src/config/env", () => ({ env: { enablePayments: false } }));
    const q = require("../../src/queues/payment.queue");
    await expect(q.enqueueReconcilePaymentsJob()).resolves.toBe(false);
  });
});

describe("webhook.queue coverage boost", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.REDIS_URL;
  });

  test("enqueueRazorpayWebhookJob skips when payments disabled", async () => {
    jest.doMock("../../src/config/env", () => ({ env: { enablePayments: false } }));
    const q = require("../../src/queues/webhook.queue");
    await expect(
      q.enqueueRazorpayWebhookJob({ paymentId: "pay_1", webhookEvent: "payment.captured", eventId: "evt1" })
    ).resolves.toEqual({ ok: true, skipped: true });
  });

  test("enqueueRazorpayWebhookJob falls back inline when queue unavailable", async () => {
    const invokeFinalizeRazorpayPaymentCaptured = jest.fn().mockResolvedValue({ ok: true });
    jest.doMock("../../src/config/env", () => ({ env: { enablePayments: true } }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: jest.fn(() => null) }));
    jest.doMock("../../src/services/paymentFinalizerInvoke.service", () => ({
      invokeFinalizeRazorpayPaymentCaptured,
    }));
    const q = require("../../src/queues/webhook.queue");
    await expect(
      q.enqueueRazorpayWebhookJob({ paymentId: "pay_2", webhookEvent: "payment.captured", eventId: "evt2" })
    ).resolves.toEqual({ ok: true });
    expect(invokeFinalizeRazorpayPaymentCaptured).toHaveBeenCalled();
  });

  test("startWebhookWorker returns null when NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const q = require("../../src/queues/webhook.queue");
    expect(q.startWebhookWorker()).toBeNull();
  });
});
