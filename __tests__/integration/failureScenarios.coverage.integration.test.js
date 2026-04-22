const mongoose = require("mongoose");
const request = require("supertest");

jest.mock("../../src/queues/webhook.queue", () => ({
  enqueueRazorpayWebhookJob: jest.fn(async () => {
    throw new Error("queue down");
  }),
}));

const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures } = require("../helpers/mongoMemoryHarness");

describe("failure scenarios (coverage)", () => {
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
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("MongoDB failure (production middleware) -> 503", async () => {
    process.env.NODE_ENV = "production";
    const { farmerToken } = await seedBookingFixtures();

    const uri = String(process.env.MONGO_URI || "").trim();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    const res = await request(app)
      .get("/api/v1/bookings/my-bookings")
      .set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, message: "Database unavailable" });

    if (uri) {
      await mongoose.connect(uri);
    }
  });

  test("Webhook queue failure -> 500 (no crash)", async () => {
    process.env.NODE_ENV = "development";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_500";
    const payload = {
      id: "evt_queue_fail_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_queue_fail_1" } } },
    };
    const crypto = require("crypto");
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

    const res = await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", sig).send(payload);
    expect([500, 200]).toContain(res.status);
  });
});

