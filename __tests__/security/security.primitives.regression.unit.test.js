const crypto = require("crypto");

describe("security regressions: otp and payment primitives", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  test("verifyOtp invalid attempt uses atomic findOneAndUpdate increment (no read-modify-save)", async () => {
    const mockUser = {
      _id: "507f191e810c19729de860ea",
      otp: "stored-hash",
      otpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      otpVerifyAttempts: 0,
      save: jest.fn(),
    };
    const findOneSelect = jest.fn().mockResolvedValue(mockUser);
    const findOneAndUpdateSelect = jest.fn().mockResolvedValue({ otpVerifyAttempts: 1 });

    jest.doMock("../../src/models/user.model", () => ({
      findOne: jest.fn(() => ({ select: findOneSelect })),
      findOneAndUpdate: jest.fn(() => ({ select: findOneAndUpdateSelect })),
      updateOne: jest.fn(),
      findById: jest.fn(),
    }));
    jest.doMock("bcryptjs", () => ({
      compare: jest.fn().mockResolvedValue(false),
      hash: jest.fn(),
    }));
    jest.doMock("../../src/services/otp.service", () => ({
      sendOTP: jest.fn(),
    }));

    const User = require("../../src/models/user.model");
    const { verifyOtp } = require("../../src/controllers/auth.controller");

    const req = { body: { phone: "9999999999", otp: "000000" } };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
    const next = jest.fn();

    await verifyOtp(req, res, next);

    expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: mockUser._id,
        otpVerifyAttempts: { $lt: expect.any(Number) },
      }),
      { $inc: { otpVerifyAttempts: 1 } },
      { new: true }
    );
    expect(mockUser.save).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("verifyPayment uses crypto.timingSafeEqual for signature check", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_id";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";

    const timingSafeEqualSpy = jest.spyOn(crypto, "timingSafeEqual");
    const { verifyPayment } = require("../../src/services/payment.service");

    const orderId = "order_123";
    const paymentId = "pay_456";
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const out = await verifyPayment({ orderId, paymentId, signature });

    expect(out.verified).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });
});
