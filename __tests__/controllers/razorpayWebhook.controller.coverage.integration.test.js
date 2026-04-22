const crypto = require("crypto");
const request = require("supertest");

jest.mock("../../src/queues/webhook.queue", () => ({
  enqueueRazorpayWebhookJob: jest.fn(async () => {}),
}));

const { enqueueRazorpayWebhookJob } = require("../../src/queues/webhook.queue");
const WebhookEvent = require("../../src/models/webhookEvent.model");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("razorpayWebhook.controller (coverage)", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_123";
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  function signPayload(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    return { sig, raw };
  }

  test("Valid signature -> success 200 and enqueues job", async () => {
    const payload = {
      id: "evt_test_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_webhook_1" } } },
    };
    const { sig } = signPayload(payload);

    const res = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(enqueueRazorpayWebhookJob).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_webhook_1", webhookEvent: "payment.captured" })
    );
  });

  test("Invalid signature -> 401", async () => {
    const payload = {
      id: "evt_test_2",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_webhook_2" } } },
    };

    const res = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", "deadbeef")
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  test("Missing signature -> 400 (invalid webhook request)", async () => {
    const payload = {
      id: "evt_test_3",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_webhook_3" } } },
    };
    const res = await request(app).post("/api/v1/webhooks/razorpay").send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
  });

  test("Duplicate webhook event -> processed once (dedupe)", async () => {
    const payload = {
      id: "evt_dup_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_webhook_dup_1" } } },
    };
    const { sig } = signPayload(payload);

    const a = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);
    const b = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const count = await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_dup_1" });
    expect(count).toBe(1);
  });
});

