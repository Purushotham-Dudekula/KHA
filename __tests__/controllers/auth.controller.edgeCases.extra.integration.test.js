const bcrypt = require("bcryptjs");
const request = require("supertest");

const { createApp } = require("../../src/app");
const User = require("../../src/models/user.model");
const { MAX_OTP_VERIFY_ATTEMPTS } = require("../../src/constants/otp");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("auth.controller edge cases extra", () => {
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

  test("Invalid phone -> 400", async () => {
    const res = await request(app).post("/api/v1/auth/send-otp").send({ phone: "abc123" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      message: expect.any(String),
    });
  });

  test("Invalid OTP -> 400", async () => {
    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone: "9999000001", otp: "12" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      message: expect.any(String),
    });
  });

  test("Too many attempts -> 429", async () => {
    const phone = "9999000003";
    const otpHash = await bcrypt.hash("123456", 10);
    await User.create({
      phone,
      otp: otpHash,
      otpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      otpVerifyAttempts: MAX_OTP_VERIFY_ATTEMPTS - 1,
    });

    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone, otp: "000000" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      success: false,
      message: expect.any(String),
    });
  });
});
