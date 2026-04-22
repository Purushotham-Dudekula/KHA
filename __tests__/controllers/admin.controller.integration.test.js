const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("admin.controller", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
  });

  test("Access with admin -> success", async () => {
    const admin = await Admin.create({
      name: "Admin Test 1",
      email: "admin_test_1@example.com",
      role: "admin",
      isActive: true,
    });

    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET);

    const res = await request(app).get("/api/v1/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("Access with normal user -> 403", async () => {
    const adminInactive = await Admin.create({
      name: "Admin Test 2",
      email: "admin_test_2@example.com",
      role: "admin",
      isActive: false,
    });

    const token = jwt.sign({ id: String(adminInactive._id), scope: "admin" }, process.env.JWT_SECRET);

    const res = await request(app).get("/api/v1/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

