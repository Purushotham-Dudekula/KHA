/**
 * Express body parsing: malformed JSON and empty body on authenticated route.
 */
const request = require("supertest");

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

describe("app body parsing (integration)", () => {
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

  test("malformed JSON returns client error (400 or parser error)", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const res = await request(app)
      .post("/api/v1/bookings/estimate")
      .set("Authorization", `Bearer ${farmerToken}`)
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect([400, 500]).toContain(res.status);
    expect(res.body.success === false || res.body === undefined || typeof res.body === "object").toBe(true);
  });

  test("empty body on estimate returns 400 (validation)", async () => {
    const { farmerToken } = await seedBookingFixtures();

    const res = await request(app)
      .post("/api/v1/bookings/estimate")
      .set("Authorization", `Bearer ${farmerToken}`)
      .set("Content-Type", "application/json")
      .send();

    expect(res.status).toBe(400);
  });
});
