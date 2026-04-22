jest.mock("../../src/utils/otpCrypto", () => ({
  generateSixDigitOtp: jest.fn(() => "123456"),
}));

const request = require("supertest");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("auth.controller", () => {
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

  test("OTP send success", async () => {
    const res = await request(app).post("/api/v1/auth/send-otp").send({ phone: "9999000005" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("OTP verify success", async () => {
    const phone = "9999000006";
    await request(app).post("/api/v1/auth/send-otp").send({ phone }).expect(200);

    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone, otp: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.token).toBeTruthy();
  });

  test("Invalid OTP -> 400", async () => {
    const phone = "9999000007";
    await request(app).post("/api/v1/auth/send-otp").send({ phone }).expect(200);

    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone, otp: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("Missing fields -> 400", async () => {
    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone: "9999000008" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

