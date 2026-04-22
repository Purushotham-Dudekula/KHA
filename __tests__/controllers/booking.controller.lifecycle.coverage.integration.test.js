const request = require("supertest");

const { createApp } = require("../../src/app");
const Booking = require("../../src/models/booking.model");
const Payment = require("../../src/models/payment.model");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

describe("booking.controller lifecycle (start/progress/complete/invoice)", () => {
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

  async function makeConfirmedAdvancePaidBooking() {
    const { farmerToken, operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "confirmed";
    booking.paymentStatus = "advance_paid";
    await booking.save();

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: booking.advanceAmount || 10,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      paymentId: "pay_adv_success_1",
      orderId: "order_adv_success_1",
      transactionId: "txn_adv_success_1",
    });

    return { farmerToken, operatorToken, booking };
  }

  test("startJob -> 200 and booking becomes in_progress", async () => {
    const { operatorToken, booking } = await makeConfirmedAdvancePaidBooking();

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/start`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "start" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { booking: expect.any(Object) } });

    const refreshed = await Booking.findById(booking._id).lean();
    expect(refreshed.status).toBe("in_progress");
    expect(refreshed.progress).toBe(0);
  });

  test("updateBookingProgress -> 200 with imagesUploaded=false when no images", async () => {
    const { operatorToken, booking } = await makeConfirmedAdvancePaidBooking();
    // move to in_progress
    await Booking.updateOne({ _id: booking._id }, { $set: { status: "in_progress" } });

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/progress`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ progress: 25 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        booking: expect.any(Object),
        progress: 25,
        imagesUploaded: false,
      },
    });
  });

  test("completeJob -> 200 and booking becomes completed + balance_due", async () => {
    const { operatorToken, booking } = await makeConfirmedAdvancePaidBooking();
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { status: "in_progress", paymentStatus: "advance_paid", startTime: new Date() } }
    );

    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ finalAmount: 3000, priceDifferenceReason: "extra acres" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { booking: expect.any(Object) } });

    const refreshed = await Booking.findById(booking._id).lean();
    expect(refreshed.status).toBe("completed");
    expect(refreshed.paymentStatus).toBe("balance_due");
    expect(refreshed.progress).toBe(100);
  });

  test("getBookingInvoice success -> returns stored invoiceUrl JSON (no regeneration)", async () => {
    const { farmerToken, booking } = await makeConfirmedAdvancePaidBooking();
    const invoiceUrl = "https://res.cloudinary.com/demo/raw/upload/v1/invoice.pdf";
    await Booking.updateOne({ _id: booking._id }, { $set: { invoiceUrl } });

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/invoice`)
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        invoiceUrl,
      },
    });
  });

  test("startJob invalid ObjectId -> 400", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app)
      .patch("/api/v1/bookings/not-an-objectid/start")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "start" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });

  test("Operator unauthorized (farmer token) -> 403 for startJob", async () => {
    const { farmerToken, booking } = await makeConfirmedAdvancePaidBooking();
    const res = await request(app)
      .patch(`/api/v1/bookings/${booking._id}/start`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ phase: "start" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });
});

