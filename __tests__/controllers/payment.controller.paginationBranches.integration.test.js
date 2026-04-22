/**
 * payment.controller parseMyPaymentsPagination branches via HTTP (limit/page edge cases).
 */
const request = require("supertest");
const Payment = require("../../src/models/payment.model");
const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

describe("payment.controller pagination branches", () => {
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("limit NaN falls back to default 10; page coerced", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 1,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      paymentId: "pay_pg_1",
      orderId: "ord_pg_1",
    });

    const res = await request(app)
      .get("/api/v1/payments/my?page=notanumber&limit=notanumber")
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.payments.length).toBeLessThanOrEqual(10);
  });

  test("limit capped at 100", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 1,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      paymentId: "pay_pg_2",
      orderId: "ord_pg_2",
    });

    const res = await request(app)
      .get("/api/v1/payments/my?limit=500")
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.payments.length).toBeLessThanOrEqual(100);
  });
});
