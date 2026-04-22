const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures, createPendingBookingForFarmer, futureBookingDate } = require("../helpers/mongoMemoryHarness");

describe("admin dashboard analytics (demand-analytics)", () => {
  let app;
  let admin;
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

    admin = await Admin.create({
      name: "Admin Dashboard Test",
      email: "admin_dashboard@example.com",
      role: "admin",
      isActive: true,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("valid request -> success", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    // Create at least one booking scheduled within the requested window.
    await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .get("/api/v1/admin/demand-analytics")
      .set("Authorization", `Bearer ${token}`)
      .query({ startDate, endDate });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        serviceDemand: expect.any(Array),
        monthlyDemand: expect.any(Array),
        peakHours: expect.any(Array),
        totalBookings: expect.any(Number),
        topServiceTypes: expect.any(Array),
        bookingsByDate: expect.any(Array),
      })
    );
    expect(res.body.data.totalBookings).toBeGreaterThanOrEqual(1);
  });

  test("invalid date range -> 400", async () => {
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .get("/api/v1/admin/demand-analytics")
      .set("Authorization", `Bearer ${token}`)
      .query({ startDate: "not-a-date", endDate: futureBookingDate() });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("empty data -> returns empty response", async () => {
    // No bookings seeded in this test (only admin + reset).
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await request(app)
      .get("/api/v1/admin/demand-analytics")
      .set("Authorization", `Bearer ${token}`)
      .query({ startDate, endDate });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalBookings).toBe(0);
    expect(res.body.data.serviceDemand).toEqual([]);
    expect(res.body.data.monthlyDemand).toEqual([]);
    expect(res.body.data.peakHours).toEqual([]);
    expect(res.body.data.topServiceTypes).toEqual([]);
    expect(res.body.data.bookingsByDate).toEqual([]);
  });
});

