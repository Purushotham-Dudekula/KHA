const request = require("supertest");

const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("razorpayWebhook signature gate (production)", () => {
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
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_prod_gate_test";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("wrong signature in production returns 400", async () => {
    const payload = {
      id: "evt_prod_sig_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_prod_sig_1" } } },
    };

    const res = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", "deadbeef")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Invalid webhook signature" });
  });
});
