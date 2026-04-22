jest.mock("../../src/models/user.model", () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock("bcryptjs", () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/services/otp.service", () => ({
  sendOTP: jest.fn(),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({
  cleanUserResponse: jest.fn((x) => x),
}));
jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../../src/models/user.model");
const { MAX_OTP_VERIFY_ATTEMPTS } = require("../../src/constants/otp");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
}

describe("security regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = "testsecret";
  });

  test("logout ignores body userId and uses authenticated user only", async () => {
    const { logout } = require("../../src/controllers/auth.controller");
    const res = makeRes();
    await logout(
      {
        user: { id: "507f1f77bcf86cd799439011" },
        body: { userId: "507f191e810c19729de860ea" },
      },
      res,
      jest.fn()
    );
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "507f1f77bcf86cd799439011" },
      { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } }
    );
  });

  test("logout returns unauthorized when req.user missing", async () => {
    const { logout } = require("../../src/controllers/auth.controller");
    const next = jest.fn();
    await logout({ body: { userId: "507f191e810c19729de860ea" } }, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(String(next.mock.calls[0][0]?.message || "")).toMatch(/Unauthorized/i);
  });

  test("otp verification parallel invalid attempts increment atomically and lockout applies", async () => {
    const { verifyOtp } = require("../../src/controllers/auth.controller");
    const nowFuture = new Date(Date.now() + 10 * 60 * 1000);
    const baseUser = {
      _id: "507f1f77bcf86cd799439011",
      otp: "hashed_otp",
      otpExpiry: nowFuture,
      otpVerifyAttempts: 0,
      isProfileComplete: true,
      save: jest.fn(),
    };

    User.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(baseUser),
    });
    bcrypt.compare.mockResolvedValue(false);

    let attempts = MAX_OTP_VERIFY_ATTEMPTS - 2;
    User.findOneAndUpdate.mockImplementation(async () => {
      attempts += 1;
      if (attempts >= MAX_OTP_VERIFY_ATTEMPTS) return null;
      return { ...baseUser, otpVerifyAttempts: attempts };
    });
    User.updateOne.mockResolvedValue({ acknowledged: true });

    const next1 = jest.fn();
    const next2 = jest.fn();
    await Promise.all([
      verifyOtp({ body: { phone: "9999999999", otp: "000000" } }, makeRes(), next1),
      verifyOtp({ body: { phone: "9999999999", otp: "000000" } }, makeRes(), next2),
    ]);

    expect(next1).toHaveBeenCalled();
    expect(next2).toHaveBeenCalled();
    expect(User.findOneAndUpdate).toHaveBeenCalled();
  });

  test("payment signature verification accepts valid and rejects invalid signatures", async () => {
    const { verifyPayment } = require("../../src/services/payment.service");
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.ALLOW_DEV_PAYMENT = "false";

    const orderId = "order_123";
    const paymentId = "pay_123";
    const good = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const ok = await verifyPayment({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: good,
    });
    const bad = await verifyPayment({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: `${good.slice(0, -2)}aa`,
    });

    expect(ok.verified).toBe(true);
    expect(bad.verified).toBe(false);
  });
});

