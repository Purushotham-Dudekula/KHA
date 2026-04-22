const crypto = require("crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

const WebhookEvent = require("../../src/models/webhookEvent.model");

describe("payment.controller edge cases", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    await resetDatabase();
  });

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    delete process.env.REDIS_URL;
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_1";
  });

  test("duplicate webhook -> idempotent (event stored once)", async () => {
    await WebhookEvent.ensureIndexes();

    const payload = {
      id: "evt_dup_pay_edge_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_dup_pay_edge_1" } } },
    };

    const raw = Buffer.from(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

    const [a, b] = await Promise.all([
      request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", signature).send(payload),
      request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", signature).send(payload),
    ]);

    expect([200, 500]).toContain(a.status);
    expect([200, 500]).toContain(b.status);

    const count = await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_dup_pay_edge_1" });
    expect(count).toBe(1);
  });

  test("invalid webhook signature -> 401 and does not persist", async () => {
    await WebhookEvent.ensureIndexes();

    const payload = {
      id: "evt_invalid_sig_edge_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_invalid_sig_edge_1" } } },
    };

    const res = await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", "bad_signature").send(payload);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);

    const count = await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_invalid_sig_edge_1" });
    expect(count).toBe(0);
  });

  test("remaining payment success", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    booking.remainingAmount = 1925;
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-remaining`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        paymentId: "pay_rem_success_1",
        orderId: "order_rem_success_1",
        signature: "sig_rem_success_1",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("payment before accept -> fail (pay-advance before booking accepted)", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    // booking is still pending; pay-advance requires status=accepted + paymentStatus=advance_due.

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        paymentId: "pay_before_accept_1",
        orderId: "order_before_accept_1",
        signature: "sig_before_accept_1",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

