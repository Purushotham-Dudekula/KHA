const mongoose = require("mongoose");
const request = require("supertest");

const verifyPaymentDelayMs = { ms: 0 };

jest.mock("../../src/services/payment.service", () => {
  const actual = jest.requireActual("../../src/services/payment.service");
  return {
    ...actual,
    // Slow down only when needed to make Idempotency-Key overlap deterministic.
    verifyPayment: jest.fn(async (data) => {
      const ms = Number(verifyPaymentDelayMs.ms) || 0;
      if (ms > 0) {
        await new Promise((r) => setTimeout(r, ms));
      }
      const orderId = data?.razorpay_order_id || data?.orderId || "";
      const paymentId = data?.razorpay_payment_id || data?.paymentId || "";
      return {
        verified: true,
        orderId,
        paymentId,
        message: "DEV MODE BYPASS",
      };
    }),
  };
});

const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");
const IdempotencyKey = require("../../src/models/idempotencyKey.model");
const { verifyPayment } = require("../../src/services/payment.service");

describe("payment.controller (pay-advance flow)", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    delete process.env.REDIS_URL;
    verifyPaymentDelayMs.ms = 0;
    await IdempotencyKey.ensureIndexes();
  });

  test("Pay advance success", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_dev_advance_1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("Duplicate payment returns cached first response", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const idem = "idem_pay_advance_dup_1";

    // Ensure first request stays "in progress" long enough for deterministic overlap.
    verifyPaymentDelayMs.ms = 300;

    // booking.controller may have been loaded earlier in this Jest run; force it to re-evaluate
    // so it picks up the mocked payment.service.verifyPayment implementation.
    const dupApp = (() => {
      const appPath = require.resolve("../../src/app");
      const routesPath = require.resolve("../../src/routes");
      const bookingRoutesPath = require.resolve("../../src/routes/booking.routes");
      const bookingControllerPath = require.resolve("../../src/controllers/booking/booking.index.js");
      delete require.cache[appPath];
      delete require.cache[routesPath];
      delete require.cache[bookingRoutesPath];
      delete require.cache[bookingControllerPath];
      return require("../../src/app").createApp();
    })();

    const [a, b] = await Promise.all([
      request(dupApp)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idem)
        .send({ paymentMethod: "upi" }),
      request(dupApp)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idem)
        .send({ paymentMethod: "upi" }),
    ]);

    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(verifyPayment).toHaveBeenCalledTimes(1);
  });

  test("Invalid booking -> 404", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const invalidBookingId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(`/api/v1/bookings/${invalidBookingId}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_dev_invalid_booking_1" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("Unauthorized -> 401", async () => {
    const { farmerToken: _farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app).post(`/api/v1/bookings/${booking._id}/pay-advance`).send({
      paymentMethod: "upi",
      transactionId: "txn_dev_unauth_1",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

