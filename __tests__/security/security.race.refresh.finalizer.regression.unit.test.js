const jwt = require("jsonwebtoken");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
}

describe("security regressions: otp/finalizer/refresh", () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test("OTP single-use enforcement: parallel verifies allow only one success", async () => {
    const user = {
      _id: "507f1f77bcf86cd799439011",
      otp: "hashed",
      otpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      otpVerifyAttempts: 0,
      isProfileComplete: true,
    };
    let consumeCalls = 0;
    jest.doMock("../../src/models/user.model", () => ({
      findOne: jest.fn(() => ({ select: jest.fn().mockResolvedValue(user) })),
      findOneAndUpdate: jest.fn((q, u) => {
        if (u?.$inc?.otpVerifyAttempts) return { select: jest.fn().mockResolvedValue({ otpVerifyAttempts: 1 }) };
        consumeCalls += 1;
        return Promise.resolve(consumeCalls === 1 ? user : null);
      }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      findById: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(user) }),
    }));
    jest.doMock("bcryptjs", () => ({
      compare: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue("h2"),
    }));
    jest.doMock("../../src/utils/apiResponse", () => ({
      sendSuccess: jest.fn((res, status) => res.status(status).json({ success: true })),
    }));
    const { verifyOtp } = require("../../src/controllers/auth.controller");

    process.env.JWT_SECRET = "testsecret";
    const next1 = jest.fn();
    const next2 = jest.fn();
    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      verifyOtp({ body: { phone: "9999999999", otp: "123456" } }, res1, next1),
      verifyOtp({ body: { phone: "9999999999", otp: "123456" } }, res2, next2),
    ]);

    expect([res1.status.mock.calls[0]?.[0], res2.status.mock.calls[0]?.[0]].sort()).toEqual([200, 400]);
  });

  test("Admin OTP race prevention: second consume fails as already used", async () => {
    const admin = {
      _id: "507f191e810c19729de860ea",
      email: "admin@example.com",
      isActive: true,
      otp: "hashed",
      otpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      otpVerifyAttempts: 0,
      role: "admin",
    };
    let consumeCalls = 0;
    jest.doMock("../../src/models/admin.model", () => ({
      findOne: jest.fn(() => ({ select: jest.fn().mockResolvedValue(admin) })),
      findOneAndUpdate: jest.fn((q, u) => {
        if (u?.$inc?.otpVerifyAttempts) return { select: jest.fn().mockResolvedValue({ otpVerifyAttempts: 1 }) };
        consumeCalls += 1;
        return Promise.resolve(consumeCalls === 1 ? admin : null);
      }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    }));
    jest.doMock("bcryptjs", () => ({
      compare: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue("h"),
    }));
    jest.doMock("../../src/utils/apiResponse", () => ({
      sendSuccess: jest.fn((res, status) => res.status(status).json({ success: true })),
    }));
    const { adminVerifyOtp } = require("../../src/controllers/adminAuth.controller");

    process.env.JWT_SECRET = "testsecret";
    process.env.JWT_EXPIRES_IN = "1h";
    const res1 = makeRes();
    const res2 = makeRes();
    const next1 = jest.fn();
    const next2 = jest.fn();
    await Promise.all([
      adminVerifyOtp({ body: { email: admin.email, otp: "123456" } }, res1, next1),
      adminVerifyOtp({ body: { email: admin.email, otp: "123456" } }, res2, next2),
    ]);

    const statusA = res1.status.mock.calls[0]?.[0];
    const statusB = res2.status.mock.calls[0]?.[0];
    expect([statusA, statusB]).toContain(200);
    expect(next1.mock.calls.length + next2.mock.calls.length).toBeGreaterThanOrEqual(1);
    const allErrors = [...next1.mock.calls, ...next2.mock.calls].map((c) => c[0]).filter(Boolean);
    expect(allErrors.some((e) => e.statusCode === 400)).toBe(true);
  });

  test("Payment finalizer failure bubbles and prevents webhook success response", async () => {
    jest.doMock("../../src/models/webhookEvent.model", () => ({
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    }));
    jest.doMock("../../src/services/paymentFinalizer.service", () => ({
      finalizeRazorpayPaymentCaptured: jest.fn().mockResolvedValue({ ok: false, message: "boom" }),
    }));
    jest.doMock("../../src/queues/redis.connection", () => ({
      createBullConnection: jest.fn().mockReturnValue(null),
    }));
    const { razorpayWebhook } = require("../../src/controllers/razorpayWebhook.controller");

    process.env.RAZORPAY_WEBHOOK_SECRET = "webhook_secret";
    const payload = {
      id: "evt_1",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1" } } },
      created_at: Date.now(),
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = require("crypto").createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    const req = {
      rawBody: raw,
      body: payload,
      get: jest.fn((h) => (h === "x-razorpay-signature" ? signature : "")),
    };
    const res = makeRes();
    const next = jest.fn();

    await razorpayWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  test("Refresh token misuse: cookie token subject mismatch returns 401", async () => {
    jest.doMock("../../src/models/user.model", () => ({
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd799439011",
          refreshTokenHash: "stored_hash",
          refreshTokenExpiresAt: new Date(Date.now() + 3600_000),
        }),
      }),
      updateOne: jest.fn(),
    }));
    jest.doMock("bcryptjs", () => ({
      compare: jest.fn().mockResolvedValue(false),
      hash: jest.fn(),
    }));
    const { refreshToken } = require("../../src/controllers/auth.controller");

    process.env.JWT_SECRET = "testsecret";
    const otherToken = jwt.sign({ id: "507f191e810c19729de860ea" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const next = jest.fn();
    await refreshToken({ headers: { cookie: `refreshToken=${otherToken}` }, body: {} }, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(String(next.mock.calls[0][0]?.message || "")).toMatch(/invalid/i);
  });
});
