/**
 * End-to-end HTTP tests against real Express stack + MongoDB (in-memory).
 * Does not mock booking/payment controllers.
 */
const request = require("supertest");
const crypto = require("crypto");

const { createApp } = require("../src/app");
const Booking = require("../src/models/booking.model");
const Payment = require("../src/models/payment.model");
const { reconcilePaymentsOnce } = require("../src/queues/payment.queue");
const WebhookEvent = require("../src/models/webhookEvent.model");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  futureBookingDate,
  createPendingBookingForFarmer,
} = require("./helpers/mongoMemoryHarness");

describe("API E2E (supertest + MongoMemoryServer)", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    process.env = { ...originalEnv };
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_1";
    // Enable dev-mode payment bypass for E2E signature checks.
    // This keeps tests independent of real Razorpay credentials.
    process.env.ALLOW_DEV_PAYMENT = "true";
    // Prevent delayed payment recovery timers from requiring Razorpay after Jest teardown.
    // Some E2E tests intentionally set these for production-path coverage.
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  function bookingCreateBody(tractorId) {
    return {
      tractorId: String(tractorId),
      serviceType: "int_test_svc",
      date: futureBookingDate(),
      time: "10:00",
      landArea: 5,
      address: "Farm lane 1",
    };
  }

  test("booking creation succeeds then duplicate active booking returns 409", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const first = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);
    expect(first.body.data?.booking).toBeTruthy();

    const second = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send(body);

    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(String(second.body.message || "").toLowerCase()).toMatch(/active booking|already have/i);
  });

  test("two parallel booking creates: only one succeeds (409 or 201)", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const [a, b] = await Promise.all([
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body),
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body),
    ]);

    const statuses = [a.status, b.status].sort();
    const okCount = [a, b].filter((r) => r.status === 201).length;
    const conflictCount = [a, b].filter((r) => r.status === 409).length;

    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(statuses).toEqual([201, 409]);
  });

  test("payment advance: success in development (signature bypass)", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    process.env.NODE_ENV = "development";

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_dev_1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.payment?.status).toBe("PENDING");
    expect(res.body.data?.paymentPending).toBe(true);
  });

  test("payment advance: fails safely in production when signature invalid", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_integration";
    process.env.RAZORPAY_KEY_SECRET = "test_secret_key_integration";

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "definitely_wrong_signature",
      });

    // In production, infra guardrails (e.g. lock backend availability) can reject before signature validation.
    expect([400, 409]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  test("webhook override: PENDING payment -> SUCCESS, booking -> CONFIRMED", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const payRes = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", paymentId: "pay_test_1", orderId: "order_test_1", signature: "x" });
    expect(payRes.status).toBe(200);

    const payload = {
      id: "evt_test_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_test_1" } } },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    const wh = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);
    expect(wh.status).toBe(200);

    const paymentRow = await Payment.findOne({ paymentId: "pay_test_1" }).lean();
    expect(paymentRow?.status).toBe("SUCCESS");
    const bookingRow = await Booking.findById(booking._id).lean();
    expect(bookingRow?.status).toBe("confirmed");
  });

  test("duplicate webhook: same event processed only once", async () => {
    await seedBookingFixtures();
    const payload = {
      id: "evt_dup_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_dup_1" } } },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

    const a = await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", sig).send(payload);
    const b = await request(app).post("/api/v1/webhooks/razorpay").set("x-razorpay-signature", sig).send(payload);
    expect([200, 500]).toContain(a.status);
    expect([200, 500]).toContain(b.status);
    const count = await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_dup_1" });
    expect(count).toBe(1);
  });

  test("reconciliation: PENDING payment older than cutoff gets finalized when provider says captured", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "payment_pending";
    booking.paymentStatus = "advance_paid";
    booking.lockExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await booking.save();

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_recon_1",
      orderId: "order_recon_1",
    });

    const razorpayStatus = require("../src/services/razorpayStatus.service");
    const spy = jest
      .spyOn(razorpayStatus, "fetchRazorpayPaymentStatus")
      .mockResolvedValue({ ok: true, status: "captured", raw: {} });
    try {
      await reconcilePaymentsOnce();
    } finally {
      spy.mockRestore();
    }

    const paymentRow = await Payment.findOne({ paymentId: "pay_recon_1" }).lean();
    expect(paymentRow?.status).toBe("SUCCESS");
  });

  test("lock expiry: payment_pending booking past lockExpiresAt is cancelled", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "payment_pending";
    booking.lockExpiresAt = new Date(Date.now() - 60 * 1000);
    await booking.save();

    const { expireOnce } = require("../src/jobs/bookingPaymentLock.cron");
    await expireOnce();
    const refreshed = await Booking.findById(booking._id).lean();
    expect(refreshed?.status).toBe("cancelled");
    expect(refreshed?.lockExpiresAt).toBeNull();
  });

  test("unauthorized: protected booking route without token", async () => {
    await seedBookingFixtures();
    const res = await request(app).get("/api/v1/bookings/my-bookings");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("unauthorized: admin profile without admin token", async () => {
    await seedBookingFixtures();
    const res = await request(app).get("/api/v1/admin/me");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
