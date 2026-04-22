/**
 * Minimal route coverage: health, support, /api/v1/version (non-production).
 */
const request = require("supertest");
const { createApp } = require("../../src/app");

describe("health / support / version routes", () => {
  const originalEnv = { ...process.env };
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("GET /api/health returns 200 and db/redis fields", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("dbStatus");
    expect(res.body.data).toHaveProperty("redisStatus");
  });

  test("GET /api/v1/support returns phone and message", async () => {
    const res = await request(app).get("/api/v1/support");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      phone: expect.any(String),
      message: expect.any(String),
    });
  });

  test("GET /api/v1/version in development returns version payload", async () => {
    process.env.NODE_ENV = "development";
    const res = await request(app).get("/api/v1/version");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: expect.any(String), status: "stable" });
  });
});
