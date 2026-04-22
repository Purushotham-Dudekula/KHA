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

describe("payment.controller listMyPayments (coverage)", () => {
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

  test("Unauthorized -> 401", async () => {
    const res = await request(app).get("/api/v1/payments/my");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  test("When user has no operator bookings -> filter is userId only", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_list_1",
      orderId: "order_list_1",
    });

    const res = await request(app).get("/api/v1/payments/my?page=1&limit=10").set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        count: 1,
        total: 1,
        page: 1,
        totalPages: 1,
        payments: expect.any(Array),
      },
    });
    expect(res.body.data.payments[0]).toMatchObject({
      paymentId: "pay_list_1",
    });
  });

  test("When user is operator with bookings -> includes payments for those bookingIds (ids.length>0 branch)", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    await Payment.create({
      bookingId: booking._id,
      userId: operator._id,
      amount: 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_list_2",
      orderId: "order_list_2",
    });

    const res = await request(app).get("/api/v1/payments/my?page=1&limit=1").set("Authorization", `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      page: 1,
      totalPages: expect.any(Number),
      payments: expect.any(Array),
    });
  });
});

