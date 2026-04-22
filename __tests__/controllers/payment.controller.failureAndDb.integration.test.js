/**
 * payment.controller: DB failure path (500 via errorHandler) and pagination edge cases.
 */
const request = require("supertest");

const Booking = require("../../src/models/booking.model");
const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

describe("payment.controller failure + pagination (integration)", () => {
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
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("500: Booking.find throws — error propagates to errorHandler", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const spy = jest.spyOn(Booking, "find").mockImplementation(() => {
      throw new Error("Simulated database failure");
    });

    const res = await request(app).get("/api/v1/payments/my").set("Authorization", `Bearer ${farmerToken}`);

    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/something went wrong/i);
  });

  test("200: pagination page beyond data — empty payments array, totalPages still >= 1", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const Payment = require("../../src/models/payment.model");
    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 10,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      paymentId: "pay_page_edge_1",
      orderId: "order_page_edge_1",
    });

    const res = await request(app)
      .get("/api/v1/payments/my?page=99&limit=10")
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payments).toEqual([]);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.page).toBe(99);
    expect(res.body.data.totalPages).toBeGreaterThanOrEqual(1);
  });
});
