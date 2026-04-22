const request = require("supertest");

const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  futureBookingDate,
} = require("../helpers/mongoMemoryHarness");

function bookingCreateBody(tractorId) {
  return {
    tractorId: String(tractorId),
    serviceType: "int_test_svc",
    date: futureBookingDate(),
    time: "10:00",
    landArea: 5,
    address: "Concurrency lane",
  };
}

describe("booking.controller concurrency", () => {
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

  test("2 parallel create requests -> one 201 and one 409", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();
    const body = bookingCreateBody(tractor._id);

    const [a, b] = await Promise.all([
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body),
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect([a.body, b.body]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ success: true }),
        expect.objectContaining({ success: false }),
      ])
    );
  });
});
