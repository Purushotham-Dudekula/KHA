const request = require("supertest");

const { createApp } = require("../../src/app");
const { seedBookingFixtures, connectMongoMemory, disconnectMongoMemory, resetDatabase, futureBookingDate } = require("../helpers/mongoMemoryHarness");

function bookingCreateBody(tractorId) {
  return {
    tractorId: String(tractorId),
    serviceType: "int_test_svc",
    date: futureBookingDate(),
    time: "10:00",
    landArea: 5,
    address: "Farm lane 1",
  };
}

describe("booking.controller", () => {
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

  test("Create booking -> success (201)", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test("Duplicate booking -> 409", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const first = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);

    const second = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
  });

  test("Invalid input -> 400", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);
    body.time = "99:99";

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("Unauthorized -> 401", async () => {
    const { tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const res = await request(app).post("/api/v1/bookings/create").send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

