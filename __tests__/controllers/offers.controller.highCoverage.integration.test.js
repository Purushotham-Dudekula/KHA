/**
 * offers.controller — public list + admin CRUD.
 */
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");

const Admin = require("../../src/models/admin.model");
const Offer = require("../../src/models/offer.model");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("offers.controller (high coverage)", () => {
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

  async function adminToken() {
    const admin = await Admin.create({
      name: "Offer Admin HC",
      email: `offer_hc_${Date.now()}@example.com`,
      role: "admin",
      isActive: true,
    });
    return jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }

  test("GET /offers → 200", async () => {
    const res = await request(app).get("/api/v1/offers");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("offers");
  });

  test("GET /offers/active → 200 array", async () => {
    const res = await request(app).get("/api/v1/offers/active");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test("POST /admin/offers without auth → 401", async () => {
    const res = await request(app).post("/api/v1/admin/offers").send({
      title: "T",
      description: "D",
      discountPercentage: 5,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /admin/offers inactive admin → 403", async () => {
    const admin = await Admin.create({
      name: "Off Inactive",
      email: `off_in_${Date.now()}@example.com`,
      role: "admin",
      isActive: false,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/admin/offers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "T",
        description: "D",
        discountPercentage: 5,
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("POST /admin/offers valid → 201", async () => {
    const token = await adminToken();
    const start = new Date(Date.now() - 3600000).toISOString();
    const end = new Date(Date.now() + 7 * 86400000).toISOString();
    const res = await request(app)
      .post("/api/v1/admin/offers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Summer Sale",
        description: "Good discount",
        discountPercentage: 15,
        startDate: start,
        endDate: end,
        isActive: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.offer.title).toBe("Summer Sale");
  });

  test("PATCH /admin/offers/:id not found → 404", async () => {
    const token = await adminToken();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/admin/offers/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Nope" });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /admin/offers/:id end before start → 400", async () => {
    const token = await adminToken();
    const offer = await Offer.create({
      title: "O",
      description: "D",
      discountPercentage: 10,
      isActive: true,
      startDate: new Date(Date.now() + 86400000),
      endDate: new Date(Date.now() + 2 * 86400000),
    });
    const res = await request(app)
      .patch(`/api/v1/admin/offers/${offer._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        startDate: new Date(Date.now() + 5 * 86400000).toISOString(),
        endDate: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("DELETE /admin/offers/:id → 200", async () => {
    const token = await adminToken();
    const offer = await Offer.create({
      title: "Del",
      description: "Del me",
      discountPercentage: 5,
      isActive: true,
      startDate: new Date(Date.now() - 3600000),
      endDate: new Date(Date.now() + 86400000),
    });
    const res = await request(app).delete(`/api/v1/admin/offers/${offer._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("DELETE /admin/offers/:id not found → 404", async () => {
    const token = await adminToken();
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request(app).delete(`/api/v1/admin/offers/${id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("POST /admin/offers Offer.create throws → 500", async () => {
    const token = await adminToken();
    jest.spyOn(Offer, "create").mockRejectedValueOnce(new Error("db"));
    const res = await request(app)
      .post("/api/v1/admin/offers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "X",
        description: "Y",
        discountPercentage: 1,
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
