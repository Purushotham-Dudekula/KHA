const request = require("supertest");

const { createApp } = require("../../src/app");
const Payment = require("../../src/models/payment.model");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

describe("payment.controller edge cases (coverage)", () => {
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("Unauthorized -> 401", async () => {
    const res = await request(app).post("/api/v1/bookings/507f1f77bcf86cd799439011/pay-advance").send({ paymentMethod: "upi" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  test("Payment before booking accepted -> fail (400/409)", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "pending";
    booking.paymentStatus = "no_payment";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_before_accept" });

    expect([400, 409]).toContain(res.status);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("Invalid paymentMethod=cash -> 400", async () => {
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
      .send({ paymentMethod: "cash" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("Duplicate payment -> 409 or returns existing payment", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
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
      amount: booking.advanceAmount || 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_dup_edge_1",
      orderId: "order_dup_edge_1",
      transactionId: "txn_dup_edge_1",
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", paymentId: "pay_dup_edge_1", orderId: "order_dup_edge_1", signature: "x" });

    expect([200, 409]).toContain(res.status);
  });

  test("Payment after completion -> fail (400/409)", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_after_complete" });

    expect([400, 409]).toContain(res.status);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });
});

