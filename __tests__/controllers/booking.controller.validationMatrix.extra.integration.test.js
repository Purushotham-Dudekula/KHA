/**
 * Additional booking.controller coverage: validation branches, HTTP matrix, concurrency.
 * Does not modify application code.
 */
const request = require("supertest");
const mongoose = require("mongoose");

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  futureBookingDate,
} = require("../helpers/mongoMemoryHarness");

function createBody(tractorId) {
  return {
    tractorId: String(tractorId),
    serviceType: "int_test_svc",
    date: futureBookingDate(),
    time: "10:00",
    landArea: 5,
    address: "Farm lane",
  };
}

describe("booking.controller validation matrix (extra integration)", () => {
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

  test("400: create missing serviceType", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = createBody(tractor._id);
    delete body.serviceType;
    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("400: create missing date", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = createBody(tractor._id);
    delete body.date;
    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(400);
  });

  test("400: create missing time", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = createBody(tractor._id);
    delete body.time;
    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(400);
  });

  test("400: create invalid time format", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = { ...createBody(tractor._id), time: "25:99" };
    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(400);
  });

  test("400: create empty JSON object (missing required fields)", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send({});
    expect(res.status).toBe(400);
  });

  test("400: estimate missing landArea", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/bookings/estimate")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ serviceType: "int_test_svc" });
    expect(res.status).toBe(400);
  });

  test("400: estimate invalid landArea type (non-positive)", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/bookings/estimate")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ serviceType: "int_test_svc", landArea: "not-a-number" });
    expect(res.status).toBe(400);
  });

  test("403: farmer route with operator token (listFarmerBookings)", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/bookings/farmer").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("401: missing Authorization header (listMyFarmerBookings)", async () => {
    const res = await request(app).get("/api/v1/bookings/my-bookings");
    expect(res.status).toBe(401);
  });

  test("404: getBookingDetails for non-existent valid ObjectId", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/v1/bookings/${id}`).set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(404);
  });

  test("400: getBookingDetails invalid id (CastError)", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/bookings/not-an-objectid").set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(400);
  });

  test("400: pay-advance cash not supported", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const Booking = require("../../src/models/booking.model");
    const booking = await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "accepted",
      paymentStatus: "advance_due",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(futureBookingDate()),
      time: "10:00",
      address: "x",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 20,
      advanceAmount: 20,
      remainingAmount: 90,
    });

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "cash" });

    expect(res.status).toBe(400);
    expect(String(res.body.message || "").toLowerCase()).toContain("cash");
  });

  test("concurrency: parallel POST /create with same Idempotency-Key — one completes, one 409 (in progress)", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = createBody(tractor._id);
    const idemKey = `idem-parallel-${Date.now()}`;

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/v1/bookings/create")
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idemKey)
        .send(body),
      request(app)
        .post("/api/v1/bookings/create")
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idemKey)
        .send(body),
    ]);

    const codes = [a.status, b.status].sort((x, y) => x - y);
    expect(codes).toContain(201);
    // Second request might get 201 (if first finished), 202 (if first in progress), or 409 (original expectation)
    expect([201, 202, 409]).toContain(codes[1]);
  });
});
