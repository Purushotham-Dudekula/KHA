const request = require("supertest");

function buildTestApp() {
  process.env.NODE_ENV = "development";
  process.env.MONGO_URI = "mongodb://127.0.0.1:27017/testdb";
  process.env.JWT_SECRET = "testsecret";
  process.env.JWT_EXPIRES_IN = "1h";
  process.env.CORS_ORIGIN = "http://localhost:3000";
  process.env.REDIS_DISABLED = "true";
  delete process.env.REDIS_URL;
  const { validateEnv } = require("../../src/config/env");
  validateEnv();
  return require("../../src/app").createApp();
}

describe("sensitive route rate limits", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("user login route (/auth/send-otp) blocks on 6th attempt in 15 minutes", async () => {
    const app = buildTestApp();
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app).post("/api/v1/auth/send-otp").send({ phone: "123" });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({
      success: false,
      message: "Too many attempts from this IP. Please try again later.",
    });
  });

  test("OTP verify route (/auth/verify-otp) blocks on 6th attempt in 15 minutes", async () => {
    const app = buildTestApp();
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app).post("/api/v1/auth/verify-otp").send({ phone: "123", otp: "1" });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({
      success: false,
      message: "Too many attempts from this IP. Please try again later.",
    });
  });

  test("OTP resend/login route (/auth/send-otp) blocks on 6th attempt in 15 minutes", async () => {
    const app = buildTestApp();
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app).post("/api/v1/auth/send-otp").send({ phone: "123" });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({
      success: false,
      message: "Too many attempts from this IP. Please try again later.",
    });
  });

  test("admin login route (/admin/login) blocks on 4th attempt in 15 minutes", async () => {
    const app = buildTestApp();
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await request(app).post("/api/v1/admin/login").send({ email: "bad", password: "x" });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({
      success: false,
      message: "Too many attempts from this IP. Please try again later.",
    });
  });

  test("refund endpoint (/admin/refunds/:bookingId) blocks on 11th attempt in 60 minutes", async () => {
    const app = buildTestApp();
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(app).post("/api/v1/admin/refunds/507f1f77bcf86cd799439011").send({
        action: "approve",
      });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({
      success: false,
      message: "Too many attempts from this IP. Please try again later.",
    });
  });
});
