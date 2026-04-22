const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");
const Offer = require("../../src/models/offer.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("offers.controller (admin)", () => {
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

  test("invalid ID -> 400", async () => {
    const admin = await Admin.create({
      name: "Offers Admin",
      email: "offers_admin@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const res = await request(app)
      .patch("/api/v1/admin/offers/not-an-objectid")
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: true });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("invalid status change -> 400", async () => {
    const admin = await Admin.create({
      name: "Offers Admin 2",
      email: "offers_admin2@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const offer = await Offer.create({
      title: "Offer 1",
      description: "Discount offer",
      discountPercentage: 10,
      isActive: true,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .patch(`/api/v1/admin/offers/${offer._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: "not-a-boolean" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("non-admin access -> 403", async () => {
    const inactiveAdmin = await Admin.create({
      name: "Inactive Offers Admin",
      email: "inactive_offers_admin@example.com",
      role: "admin",
      isActive: false,
    });
    const token = jwt.sign({ id: String(inactiveAdmin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const offer = await Offer.create({
      title: "Offer 2",
      description: "Another discount offer",
      discountPercentage: 20,
      isActive: true,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .patch(`/api/v1/admin/offers/${offer._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: false });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

