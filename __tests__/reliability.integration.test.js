const request = require("supertest");
const crypto = require("crypto");

jest.mock("../src/services/payment.service", () => {
  const actual = jest.requireActual("../src/services/payment.service");
  return {
    ...actual,
    verifyPayment: jest.fn(actual.verifyPayment),
    fetchPaymentAmountRupees: jest.fn(actual.fetchPaymentAmountRupees),
  };
});
jest.mock("../src/services/redisLock.service", () => {
  const actual = jest.requireActual("../src/services/redisLock.service");
  return {
    ...actual,
    acquireLock: jest.fn(actual.acquireLock),
  };
});

const { createApp } = require("../src/app");
const Booking = require("../src/models/booking.model");
const Payment = require("../src/models/payment.model");
const WebhookEvent = require("../src/models/webhookEvent.model");
const paymentService = require("../src/services/payment.service");
const redisLockService = require("../src/services/redisLock.service");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  futureBookingDate,
  createPendingBookingForFarmer,
} = require("./helpers/mongoMemoryHarness");

describe("reliability integration paths", () => {
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
    jest.clearAllMocks();
    await resetDatabase();
    process.env.NODE_ENV = "development";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_reliability";
    delete process.env.REDIS_URL;
    // Prevent delayed payment recovery timers from requiring Razorpay after Jest teardown.
    // These are intentionally set in some tests (production signature invalid path),
    // so we must clear them here for every test boundary.
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  function bookingCreateBody(tractorId, overrides = {}) {
    return {
      tractorId: String(tractorId),
      serviceType: "int_test_svc",
      date: futureBookingDate(),
      time: "10:00",
      landArea: 5,
      address: "Farm lane 1",
      ...overrides,
    };
  }

  test("payment failure path returns error and payment is not marked success", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    // pay-advance acquires (1) strict paymentId lock and (2) booking-stage lock
    // Mock both so production Redis requirements don't interfere with this failure-path test.
    redisLockService.acquireLock.mockResolvedValue({
      acquired: true,
      token: "test-token",
      skipped: false,
    });
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    paymentService.verifyPayment.mockResolvedValue({
      verified: true,
      orderId: "order_ok_1",
      paymentId: "pay_fail_1",
    });
    paymentService.fetchPaymentAmountRupees.mockResolvedValue({
      ok: false,
      error: new Error("Razorpay API unavailable"),
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        orderId: "order_ok_1",
        paymentId: "pay_fail_1",
        signature: "sig_ok_1",
      });

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      success: false,
      message: "Insufficient wallet balance",
      errors: null,
    });

    const paymentRow = await Payment.findOne({ bookingId: booking._id }).lean();
    expect(paymentRow).toBeNull();
    const bookingRow = await Booking.findById(booking._id).lean();
    expect(bookingRow).toMatchObject({
      status: "accepted",
      paymentStatus: "advance_due",
    });
  });

  test("payment lock concurrency: two parallel pay-advance with same paymentId -> one succeeds, other 409", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    // Deterministic in-memory lock simulation for this test:
    // - strict paymentId lock: only first caller acquires
    // - all other locks acquire successfully
    const held = new Set();
    redisLockService.acquireLock.mockImplementation(async (key) => {
      const k = String(key || "");
      if (k === "lock:payment:pay_concurrent_1") {
        if (held.has(k)) return { acquired: false, token: null, skipped: false };
        held.add(k);
        return { acquired: true, token: "token-pay-1", skipped: false };
      }
      return { acquired: true, token: `token-${k}`, skipped: false };
    });

    // Keep payment verification in dev mode (test focuses on locking, not Razorpay).
    process.env.NODE_ENV = "development";

    const body = {
      paymentMethod: "upi",
      orderId: "order_concurrent_1",
      paymentId: "pay_concurrent_1",
      signature: "sig_concurrent_1",
    };

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .send(body),
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .send(body),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const conflict = a.status === 409 ? a : b;
    expect(conflict.body).toEqual({
      success: false,
      message: "Payment already processing",
    });

    const success = a.status === 200 ? a : b;
    expect(success.body.success).toBe(true);
  });

  test("booking failure path with invalid data returns 400 and safe structure", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();

    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send(
        bookingCreateBody(tractor._id, {
          time: "25:99",
        })
      );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.toLowerCase()).toContain("time");
  });

  test("db failure simulation returns safe 500 response", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const dbSpy = jest.spyOn(Booking, "exists").mockRejectedValue(new Error("database offline"));

    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send(bookingCreateBody(tractor._id));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      message: "Something went wrong",
      errors: null,
    });

    dbSpy.mockRestore();
  });

  test("empty request body returns 400 with validation error", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.toLowerCase()).toContain("required");
  });

  test("large payload above 10kb is rejected safely", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const largeAddress = "x".repeat(12 * 1024);

    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send(bookingCreateBody(tractor._id, { address: largeAddress }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      success: false,
      message: "Payload too large",
      errors: null,
    });
  });

  test("invalid ObjectId in params returns 400", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const res = await request(app)
      .get("/api/v1/bookings/not-a-valid-object-id")
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Valid booking id is required.");
  });

  test("completed booking rejects re-action attempt with 400", async () => {
    const { farmer, operator, operatorToken, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "accept" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.toLowerCase()).toContain("pending");
  });

  test("payment already processed retry returns existing payment safely", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 825,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      paymentId: "pay_existing_1",
      orderId: "order_existing_1",
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        paymentId: "pay_existing_1",
        orderId: "order_existing_1",
        signature: "sig_existing_1",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        booking: expect.objectContaining({ _id: String(booking._id) }),
        payment: expect.objectContaining({
          paymentId: "pay_existing_1",
          status: "SUCCESS",
        }),
      })
    );
  });

  test("farmer token on admin route returns 401 with safe structure", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const res = await request(app)
      .get("/api/v1/admin/me")
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      message: "Invalid admin token.",
      errors: null,
    });
  });

  test("webhook replay with multiple duplicates stores one event only", async () => {
    await seedBookingFixtures();
    // Ensure the unique dedupe index exists before firing concurrent requests.
    // Otherwise, Mongo may allow short-lived duplicates during index build.
    await WebhookEvent.ensureIndexes();
    const payload = {
      id: "evt_multi_dup_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_multi_dup_1" } } },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app)
          .post("/api/v1/webhooks/razorpay")
          .set("x-razorpay-signature", signature)
          .send(payload)
      )
    );

    expect(responses).toHaveLength(4);
    for (const res of responses) {
      expect([200, 500]).toContain(res.status);
    }
    const count = await WebhookEvent.countDocuments({
      provider: "razorpay",
      eventId: "evt_multi_dup_1",
    });
    expect(count).toBe(1);
  });

  test("webhook with invalid signature returns 401 and does not persist event", async () => {
    await seedBookingFixtures();
    const payload = {
      id: "evt_invalid_sig_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_invalid_sig_1" } } },
    };

    const res = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", "invalid_signature")
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      message: "Invalid signature",
      errors: null,
    });

    const count = await WebhookEvent.countDocuments({
      provider: "razorpay",
      eventId: "evt_invalid_sig_1",
    });
    expect(count).toBe(0);
  });
});
