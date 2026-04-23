const request = require("supertest");

jest.mock("../../src/services/notification.service", () => {
  const actual = jest.requireActual("../../src/services/notification.service");
  return {
    ...actual,
    notifyUser: jest.fn(async () => ({})),
    notifyAdvanceReceived: jest.fn(async () => ({})),
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
const Booking = require("../../src/models/booking.model");
const User = require("../../src/models/user.model");
const jwt = require("jsonwebtoken");
const { notifyUser } = require("../../src/services/notification.service");
const { expireOnce } = require("../../src/jobs/bookingPaymentLock.cron");

describe("booking.controller targeted branch boost", () => {
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
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Cancellation before vs after window keeps cancelled status and changes penalty snapshot", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const farStart = new Date(Date.now() + 30 * 60 * 60 * 1000); // > 24h (and >2h)
    const nearStart = new Date(Date.now() + 30 * 60 * 1000); // < 24h (and <=2h)

    const beforeWindow = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
      date: farStart,
      time: "10:00",
    });
    beforeWindow.status = "accepted";
    beforeWindow.startTime = farStart;
    await beforeWindow.save();

    // Create a second farmer to avoid "farmer_one_active_booking" unique index violation
    // when having two active bookings in the same test.
    const farmer2 = await User.create({
      phone: "+917777700003",
      role: "farmer",
      name: "Farmer 2",
      landArea: 10,
    });
    const farmerToken2 = jwt.sign({ id: String(farmer2._id) }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    const afterWindow = await createPendingBookingForFarmer({
      farmerId: farmer2._id,
      operatorId: operator._id,
      tractorId: tractor._id,
      date: nearStart,
      time: "11:00",
    });
    afterWindow.status = "accepted";
    afterWindow.startTime = nearStart;
    await afterWindow.save();

    const r1 = await request(app)
      .post(`/api/v1/bookings/${beforeWindow._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({});
    const r2 = await request(app)
      .post(`/api/v1/bookings/${afterWindow._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken2}`)
      .send({});

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.data.booking.status).toBe("cancelled");
    expect(r2.body.data.booking.status).toBe("cancelled");
    expect(Number(r1.body.data.booking.cancellationCharge || 0)).toBeLessThan(
      Number(r2.body.data.booking.cancellationCharge || 0)
    );
  });

  test("Cancel assigned booking notifies operator and releases booking slot", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const slotDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.date = slotDate;
    booking.time = "10:00";
    await booking.save();

    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${booking._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ reason: "Need to reschedule" });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.booking.status).toBe("cancelled");
    expect(notifyUser).toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: operator._id,
        bookingId: booking._id,
      })
    );

    const rebook = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        tractorId: String(tractor._id),
        serviceType: "int_test_svc",
        date: slotDate.toISOString().split("T")[0],
        time: "10:00",
        landArea: 5,
        address: "Farm lane 1",
      });

    expect(rebook.status).toBe(201);
  });

  test("Complete booking without startTime is rejected", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
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
  });

  test("Cancel booking already completed is rejected", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "completed";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/cancel`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("Payment timeout expiry cancels booking and releases slot", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const slotDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "payment_pending";
    booking.paymentStatus = "advance_paid";
    booking.date = slotDate;
    booking.time = "09:30";
    booking.lockExpiresAt = new Date(Date.now() - 60 * 1000);
    await booking.save();

    await expireOnce();

    const latest = await Booking.findById(booking._id).lean();
    expect(latest.status).toBe("cancelled");
    expect(latest.cancelledBy).toBe("system");
    expect(latest.lockExpiresAt).toBeNull();

    const rebook = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        tractorId: String(tractor._id),
        serviceType: "int_test_svc",
        date: slotDate.toISOString().split("T")[0],
        time: "09:30",
        landArea: 5,
        address: "Farm lane 1",
      });

    expect(rebook.status).toBe(201);
  });

  test("Advance payment with zero wallet is rejected", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    process.env.ENABLE_WALLET_BALANCE_GUARD = "true";
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
      .send({ paymentMethod: "upi", transactionId: "txn_wallet_guard_1" });

    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Insufficient wallet balance");
  });

  test("Advance payment rejects when wallet balance is below required amount", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    process.env.ENABLE_WALLET_BALANCE_GUARD = "true";

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    booking.advanceAmount = 500;
    booking.advancePayment = 500;
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_wallet_low_1" });

    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Insufficient wallet balance");
  });
});
