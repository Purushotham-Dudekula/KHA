jest.mock("../../src/utils/otpCrypto", () => ({
  generateSixDigitOtp: jest.fn(() => "123456"),
}));

jest.mock("../../src/services/adminEmail.service", () => ({
  deliverAdminLoginOtp: jest.fn(async () => {}),
}));

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");

const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("adminAuth.controller", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
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
    app = createApp(); // recreate app to reset rate-limit counters
  });

  test("admin login success (OTP flow)", async () => {
    const admin = await Admin.create({
      name: "Admin OTP Test",
      email: "admin_otp_success@example.com",
      role: "admin",
      isActive: true,
    });

    const loginRes = await request(app)
      .post("/api/v1/admin/login")
      .send({ email: admin.email });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);

    const verifyRes = await request(app)
      .post("/api/v1/admin/verify-otp")
      .send({ email: admin.email, otp: "123456" });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data?.token).toBeTruthy();
  });

  test("missing fields -> 400", async () => {
    const res = await request(app).post("/api/v1/admin/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("invalid OTP -> 400", async () => {
    const admin = await Admin.create({
      name: "Admin OTP Invalid",
      email: "admin_otp_invalid@example.com",
      role: "admin",
      isActive: true,
    });

    // Seed OTP state directly to avoid additional rate-limited /login calls.
    const hashed = await bcrypt.hash("123456", 10);
    admin.otp = hashed;
    admin.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    admin.otpVerifyAttempts = 0;
    await admin.save();

    const res = await request(app).post("/api/v1/admin/verify-otp").send({ email: admin.email, otp: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("expired OTP -> 400", async () => {
    const admin = await Admin.create({
      name: "Admin OTP Expired",
      email: "admin_otp_expired@example.com",
      role: "admin",
      isActive: true,
    });

    // Seed OTP state directly to avoid additional rate-limited /login calls.
    const hashed = await bcrypt.hash("123456", 10);
    admin.otp = hashed;
    admin.otpExpiry = new Date(Date.now() - 1000);
    admin.otpVerifyAttempts = 0;
    await admin.save();

    const res = await request(app).post("/api/v1/admin/verify-otp").send({ email: admin.email, otp: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("unauthorized access -> 401/403", async () => {
    // No token -> 401
    const noToken = await request(app).get("/api/v1/admin/me");
    expect(noToken.status).toBe(401);
    expect(noToken.body.success).toBe(false);

    // Inactive admin -> 403
    const inactive = await Admin.create({
      name: "Inactive Admin",
      email: "admin_inactive@example.com",
      role: "admin",
      isActive: false,
    });

    const token = jwt.sign({ id: String(inactive._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/api/v1/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

