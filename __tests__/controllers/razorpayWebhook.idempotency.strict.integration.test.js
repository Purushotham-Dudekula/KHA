/**
 * Webhook: duplicate identical event — enqueue only once; second response safe.
 */
const crypto = require("crypto");
const request = require("supertest");

jest.mock("../../src/queues/webhook.queue", () => ({
  enqueueRazorpayWebhookJob: jest.fn(async () => {}),
}));

const { enqueueRazorpayWebhookJob } = require("../../src/queues/webhook.queue");
const WebhookEvent = require("../../src/models/webhookEvent.model");
const Payment = require("../../src/models/payment.model");
const Booking = require("../../src/models/booking.model");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("razorpayWebhook idempotency (strict)", () => {
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
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_strict_test";
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  function sign(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    return sig;
  }

  test("same event id + paymentId twice: first enqueues once; second 200 without second enqueue", async () => {
    const payload = {
      id: "evt_strict_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_same_id_1" } } },
    };
    const sig = sign(payload);

    const first = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);

    const second = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(enqueueRazorpayWebhookJob).toHaveBeenCalledTimes(1);

    const evCount = await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_strict_1" });
    expect(evCount).toBe(1);
  });

  test("same paymentId different event ids: two rows allowed; each first delivery enqueues (no payment row required here)", async () => {
    const base = {
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_shared" } } },
    };

    const p1 = { ...base, id: "evt_a" };
    const p2 = { ...base, id: "evt_b" };

    const r1 = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sign(p1))
      .send(p1);
    const r2 = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sign(p2))
      .send(p2);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await WebhookEvent.countDocuments({ paymentId: "pay_shared" })).toBe(2);
  });

  test("no duplicate Payment documents from webhook handler alone (collection still empty)", async () => {
    const payload = {
      id: "evt_no_pay_dup",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_isolated" } } },
    };
    const sig = sign(payload);

    await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", sig).send(payload);
    await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", sig).send(payload);

    expect(await Payment.countDocuments({ paymentId: "pay_isolated" })).toBe(0);
    expect(await Booking.countDocuments({})).toBe(0);
  });
});
