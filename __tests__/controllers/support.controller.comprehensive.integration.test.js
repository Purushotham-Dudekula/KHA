/**
 * support.controller.js — GET /api/v1/support and /api/v1/support (no auth on route).
 */
const request = require("supertest");
const { createApp } = require("../../src/app");

describe("support.controller (integration)", () => {
  const originalEnv = { ...process.env };
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("GET /api/v1/support → 200 with success, message, data", async () => {
    process.env.SUPPORT_PHONE = "+91 99999 99999";
    process.env.SUPPORT_MESSAGE = " Call us anytime ";
    const res = await request(app).get("/api/v1/support");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Support details fetched.");
    expect(res.body.data).toEqual({
      phone: "+91 99999 99999",
      message: "Call us anytime",
    });
  });

  test("GET /api/v1/support → 200 same shape", async () => {
    process.env.SUPPORT_PHONE = "";
    process.env.SUPPORT_MESSAGE = "";
    const res = await request(app).get("/api/v1/support");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.phone).toBe("string");
    expect(typeof res.body.data.message).toBe("string");
  });

  test("GET /api/v1/support uses defaults when env unset", async () => {
    delete process.env.SUPPORT_PHONE;
    delete process.env.SUPPORT_MESSAGE;
    const res = await request(app).get("/api/v1/support");
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toContain("+91");
    expect(res.body.data.message.length).toBeGreaterThan(0);
  });
});
