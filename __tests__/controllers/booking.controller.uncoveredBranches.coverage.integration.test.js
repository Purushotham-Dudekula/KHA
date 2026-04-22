const request = require("supertest");
const mongoose = require("mongoose");

const { createApp } = require("../../src/app");
const Payment = require("../../src/models/payment.model");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
  futureBookingDate,
} = require("../helpers/mongoMemoryHarness");

describe("booking.controller uncovered branches (coverage)", () => {
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
    process.env.ALLOW_DEV_PAYMENT = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("estimate booking -> invalid input (missing fields) returns 400", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).post("/api/v1/bookings/estimate").set("Authorization", `Bearer ${farmerToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("track booking -> invalid ObjectId returns 400", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/bookings/not-an-objectid/track").set("Authorization", `Bearer ${farmerToken}`);
    expect([400, 404]).toContain(res.status);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("get booking details -> missing booking returns 404", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const missingId = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/v1/bookings/${missingId}`).set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("refund preview -> missing booking returns 404", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const missingId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/v1/bookings/${missingId}/refund-preview`)
      .set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("invoice -> missing booking returns 404/400", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const missingId = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/v1/bookings/${missingId}/invoice`).set("Authorization", `Bearer ${farmerToken}`);
    expect([400, 404]).toContain(res.status);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("pay-remaining -> booking in wrong state (pending) returns 400", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "pending";
    booking.paymentStatus = "no_payment";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-remaining`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_rem_1" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Cannot process payment for this booking");
  });

  test("pay-advance -> paymentId reused on another booking returns 400", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    const otherBooking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    otherBooking.status = "accepted";
    otherBooking.paymentStatus = "advance_due";
    await otherBooking.save();
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    await Payment.create({
      bookingId: otherBooking._id,
      userId: farmer._id,
      amount: 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_reused_1",
      orderId: "order_reused_1",
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", paymentId: "pay_reused_1", orderId: "order_reused_1", signature: "x" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid payment reference.");
  });

  test("cancel booking -> already cancelled booking returns 400", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "cancelled";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ reason: "retry cancel" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("already");
  });

  test("cancel booking -> completed booking returns 400", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ reason: "too late" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Cannot cancel: completed/closed bookings cannot be cancelled.");
  });

  test("start job -> wrong booking status returns 400", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "accepted";
    booking.paymentStatus = "advance_paid";
    await booking.save();

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/start`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "start" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Cannot start job while booking status is 'accepted'.");
  });

  test("start job -> wrong payment status guard returns 400", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "confirmed";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/start`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "start" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Cannot start job while paymentStatus is 'advance_due'.");
  });

  test("start job -> en_route phase blocked by transition rule returns 400", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "confirmed";
    booking.paymentStatus = "advance_paid";
    await booking.save();

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/start`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "en_route" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("en_route is not allowed");
  });

  test("complete job -> missing startTime guard returns 400", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({ farmerId: farmer._id, operatorId: operator._id, tractorId: tractor._id });
    booking.status = "in_progress";
    booking.paymentStatus = "advance_paid";
    booking.startTime = null;
    await booking.save();

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Cannot complete job before it has been started.");
  });

  test("respond booking -> operator mismatch returns 403", async () => {
    const { operatorToken, farmer, tractor } = await seedBookingFixtures();
    const outsiderOperator = new mongoose.Types.ObjectId();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: outsiderOperator,
      tractorId: tractor._id,
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "accept" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("You can only respond to bookings assigned to you.");
  });

  test("refund preview -> user outside booking returns 401", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const outsider = new mongoose.Types.ObjectId();
    const booking = await createPendingBookingForFarmer({
      farmerId: outsider,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.farmer = outsider;
    await booking.save();

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/refund-preview`)
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("You can only preview refunds for your own bookings.");
  });

  test("create booking -> invalid enum-ish time format triggers 400 branch", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        tractorId: String(tractor._id),
        serviceType: "int_test_svc",
        date: futureBookingDate(),
        time: "10-00",
        landArea: 5,
        address: "Bad time",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });
});

