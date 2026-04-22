const jwt = require("jsonwebtoken");
const request = require("supertest");

// Mock storage to simulate an underlying cloud/storage outage.
jest.mock("../../src/services/storage.service", () => {
  const actual = jest.requireActual("../../src/services/storage.service");
  return {
    ...actual,
    getSecureFileUrl: jest.fn(async () => {
      throw new Error("Storage failure");
    }),
  };
});

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");
const Tractor = require("../../src/models/tractor.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures } = require("../helpers/mongoMemoryHarness");

describe("Redis + failure handling", () => {
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
    process.env.REDIS_URL = "";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("Redis failure -> fallback works (booking create)", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();

    const body = {
      tractorId: String(tractor._id),
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      time: "10:00",
      landArea: 5,
      address: "Farm lane 1",
    };

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test("queue not ready -> safe response (booking create still succeeds)", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();

    const body = {
      tractorId: String(tractor._id),
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      time: "10:00",
      landArea: 5,
      address: "Farm lane 2",
    };

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test("storage failure -> handled (admin secure tractor document)", async () => {
    const admin = await Admin.create({
      name: "Storage Failure Admin",
      email: "storage_failure_admin@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const { tractor } = await seedBookingFixtures();
    await Tractor.findByIdAndUpdate(tractor._id, { rcDocument: "https://example.com/rc.pdf" });

    const res = await request(app)
      .get(`/api/v1/admin/tractor/${tractor._id}/document/rc`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

