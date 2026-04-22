const mongoose = require("mongoose");
const request = require("supertest");

const verifyPaymentDelayMs = { ms: 0 };

jest.mock("../../src/services/payment.service", () => {
  const actual = jest.requireActual("../../src/services/payment.service");
  return {
    ...actual,
    verifyPayment: jest.fn(async (data) => {
      const ms = Number(verifyPaymentDelayMs.ms) || 0;
      if (ms > 0) {
        await new Promise((r) => setTimeout(r, ms));
      }
      return {
        verified: true,
        orderId: data?.razorpay_order_id || data?.orderId || "",
        paymentId: data?.razorpay_payment_id || data?.paymentId || "",
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

describe("payment.controller high-quality coverage", () => {
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
    process.env.ALLOW_DEV_PAYMENT = "true";
    delete process.env.REDIS_URL;
    verifyPaymentDelayMs.ms = 0;
    await IdempotencyKey.ensureIndexes();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  async function createAcceptedBooking() {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();
    return { farmerToken, booking };
  }

  test("Pay advance success -> 200/201 with expected shape", async () => {
    const { farmerToken, booking } = await createAcceptedBooking();
    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_high_quality_1" });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toMatchObject({
      success: true,
      message: expect.any(String),
      data: expect.any(Object),
    });
  });

  test("Duplicate payment request returns cached first response", async () => {
    const { farmerToken, booking } = await createAcceptedBooking();
    verifyPaymentDelayMs.ms = 300;

    const idem = "idem_high_quality_dup_1";
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

  test("Invalid booking id -> 404", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const missingBookingId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(`/api/v1/bookings/${missingBookingId}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_missing_booking_1" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      message: expect.any(String),
    });
  });

  test("Unauthorized -> 401", async () => {
    const { booking } = await createAcceptedBooking();
    const res = await request(app).post(`/api/v1/bookings/${booking._id}/pay-advance`).send({ paymentMethod: "upi" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      message: expect.any(String),
    });
  });
});
