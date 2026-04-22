/**
 * tractor.controller — operator/admin HTTP branches.
 */
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");

const Tractor = require("../../src/models/tractor.model");
const Booking = require("../../src/models/booking.model");
const Admin = require("../../src/models/admin.model");
const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

describe("tractor.controller (high coverage)", () => {
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
    process.env.REDIS_DISABLED = "true";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  async function activeAdmin() {
    const admin = await Admin.create({
      name: "Tractor Admin",
      email: `tractor_admin_${Date.now()}@example.com`,
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    return { admin, token };
  }

  test("POST /tractor as farmer → 403", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/tractor")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        tractorType: "medium",
        brand: "B",
        model: "M",
        registrationNumber: "REG-FARM-1",
        machineryTypes: ["int_test_svc"],
      });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ success: false, message: expect.any(String) }));
  });

  test("POST /tractor valid → 201", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/tractor")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        tractorType: "medium",
        brand: "BrandA",
        model: "ModelZ",
        registrationNumber: `REG-OK-${Date.now()}`,
        machineryTypes: ["int_test_svc"],
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("tractor");
  });

  test("GET /tractor/details/:id owning operator → 200", async () => {
    const { operatorToken, tractor } = await seedBookingFixtures();
    const res = await request(app)
      .get(`/api/v1/tractor/details/${String(tractor._id)}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("tractor");
  });

  test("GET /tractor/details/:id invalid id → 400", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app)
      .get("/api/v1/tractor/details/not-an-id")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /tractor/details/:id wrong operator → 401", async () => {
    const { operator, tractor, farmerToken } = await seedBookingFixtures();
    const res = await request(app)
      .get(`/api/v1/tractor/details/${String(tractor._id)}`)
      .set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /tractor/details/:id not found → 404", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/v1/tractor/details/${id}`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("GET /tractor/my-tractors as farmer → 403", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/tractor/my-tractors").set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /tractor/:id/availability invalid isAvailable → 400", async () => {
    const { operatorToken, tractor } = await seedBookingFixtures();
    const res = await request(app)
      .patch(`/api/v1/tractor/${String(tractor._id)}/availability`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ isAvailable: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /tractor/:id no fields → 400", async () => {
    const { operatorToken, tractor } = await seedBookingFixtures();
    const res = await request(app)
      .patch(`/api/v1/tractor/${String(tractor._id)}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("DELETE /tractor/:id with active booking → 400", async () => {
    const { farmer, operator, tractor, operatorToken } = await seedBookingFixtures();
    await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "accepted",
      paymentStatus: "no_payment",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 86400000),
      time: "10:00",
      address: "A",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 33,
      advanceAmount: 33,
      remainingAmount: 77,
    });
    const res = await request(app)
      .delete(`/api/v1/tractor/${String(tractor._id)}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("admin PATCH /tractors/:id not found → 404", async () => {
    const { token } = await activeAdmin();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/admin/tractors/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ brand: "NewBrand" });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
