/**
 * services.controller — public list + admin CRUD branches.
 */
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");

const Admin = require("../../src/models/admin.model");
const Service = require("../../src/models/service.model");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures } = require("../helpers/mongoMemoryHarness");

describe("services.controller (high coverage)", () => {
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
    await seedBookingFixtures();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  async function adminAuth() {
    const admin = await Admin.create({
      name: "Svc Admin",
      email: `svc_admin_${Date.now()}@example.com`,
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return { admin, token };
  }

  test("GET /services → 200 array data", async () => {
    const res = await request(app).get("/api/v1/services");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeTruthy();
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test("GET /services?page=2&limit=1 → 200", async () => {
    const res = await request(app).get("/api/v1/services?page=2&limit=1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("GET /services/all with search → 200", async () => {
    const res = await request(app).get("/api/v1/services/all?search=Integration");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("services");
    expect(res.body.data).toHaveProperty("count");
  });

  test("POST /services/admin without token → 401", async () => {
    const res = await request(app).post("/api/v1/services/admin").send({
      name: "X",
      code: "x_svc",
      pricePerHour: 1,
    });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /services/admin valid → 201", async () => {
    const { token } = await adminAuth();
    const code = `new_svc_${Date.now()}`;
    const res = await request(app)
      .post("/api/v1/services/admin")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "New Service",
        code,
        pricePerHour: 100,
        pricePerAcre: 200,
        isActive: true,
        types: [{ name: "standard", pricePerHour: 50, pricePerAcre: 75 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service.code).toBe(code);
  });

  test("PATCH /services/admin/:id with code field → 400", async () => {
    const { token } = await adminAuth();
    const s = await Service.findOne({ code: "int_test_svc" });
    const res = await request(app)
      .patch(`/api/v1/services/admin/${s._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "cannot_change" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /services/admin/:id unknown id → 404", async () => {
    const { token } = await adminAuth();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/services/admin/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /services/admin/:id/toggle → 200", async () => {
    const { token } = await adminAuth();
    const s = await Service.findOne({ code: "int_test_svc" });
    const res = await request(app)
      .patch(`/api/v1/services/admin/${s._id}/toggle`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service.isActive).toBe(false);
  });

  test("POST /services/admin Service.create throws → 500", async () => {
    const { token } = await adminAuth();
    jest.spyOn(Service, "create").mockRejectedValueOnce(new Error("db"));
    const res = await request(app)
      .post("/api/v1/services/admin")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Err Svc",
        code: `err_${Date.now()}`,
        pricePerHour: 1,
      });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
