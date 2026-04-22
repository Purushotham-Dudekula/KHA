jest.mock("../../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../src/queues/redis.connection", () => ({
  createBullConnection: jest.fn(),
}));
jest.mock("../../../src/services/paymentFinalizer.service", () => ({
  finalizeRazorpayPaymentCaptured: jest.fn(),
}));

const { createBullConnection } = require("../../../src/queues/redis.connection");
const { finalizeRazorpayPaymentCaptured } = require("../../../src/services/paymentFinalizer.service");

describe("webhook.queue (more unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    finalizeRazorpayPaymentCaptured.mockResolvedValue({ ok: true });
  });

  test("enqueueRazorpayWebhookJob falls back inline when queue unavailable", async () => {
    createBullConnection.mockReturnValueOnce(null);
    const { enqueueRazorpayWebhookJob } = require("../../../src/queues/webhook.queue");
    await enqueueRazorpayWebhookJob({ paymentId: "p1", webhookEvent: "payment.captured", eventId: "e1" });
    expect(finalizeRazorpayPaymentCaptured).toHaveBeenCalled();
  });

  test("startWebhookWorker returns null in test env", () => {
    process.env.NODE_ENV = "test";
    const { startWebhookWorker } = require("../../../src/queues/webhook.queue");
    expect(startWebhookWorker()).toBeNull();
  });
});

