const mongoose = require("mongoose");

jest.mock("../../src/models/booking.model", () => ({
  FARMER_ACTIVE_BOOKING_STATUSES: ["pending", "accepted", "confirmed", "payment_pending"],
  findById: jest.fn(),
}));

jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const Booking = require("../../src/models/booking.model");
const controller = require("../../src/controllers/booking/booking.index.js");
const { AppError } = require("../../src/utils/AppError");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
}

describe("booking.controller critical validation and authorization branches", () => {
  afterEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  test("payAdvance in production rejects missing UPI verification fields", async () => {
    process.env.NODE_ENV = "production";
    const req = {
      user: { _id: new mongoose.Types.ObjectId(), role: "farmer" },
      params: { id: String(new mongoose.Types.ObjectId()) },
      body: { paymentMethod: "upi" },
    };
    const res = makeRes();
    const next = jest.fn();

    await controller.payAdvance(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toMatch(/orderId, paymentId and signature are required/i);
  });

  test("payRemaining in production rejects missing UPI verification fields", async () => {
    process.env.NODE_ENV = "production";
    const req = {
      user: { _id: new mongoose.Types.ObjectId(), role: "farmer" },
      params: { id: String(new mongoose.Types.ObjectId()) },
      body: { paymentMethod: "upi" },
    };
    const res = makeRes();
    const next = jest.fn();

    await controller.payRemaining(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toMatch(/orderId, paymentId and signature are required/i);
  });

  test("getBookingRefundPreview rejects unrelated authenticated user", async () => {
    const bookingId = new mongoose.Types.ObjectId();
    const farmerId = new mongoose.Types.ObjectId();
    const operatorId = new mongoose.Types.ObjectId();
    const requesterId = new mongoose.Types.ObjectId();
    Booking.findById.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        _id: bookingId,
        farmer: farmerId,
        operator: operatorId,
        status: "confirmed",
      }),
    });

    const req = {
      user: { _id: requesterId, role: "farmer" },
      params: { id: String(bookingId) },
    };
    const res = makeRes();
    const next = jest.fn();

    await controller.getBookingRefundPreview(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toMatch(/own bookings/i);
  });

  test("payAdvance wallet guard throws 500 when wallet is undefined", async () => {
    process.env.NODE_ENV = "development";
    process.env.ENABLE_WALLET_BALANCE_GUARD = "true";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const userId = new mongoose.Types.ObjectId();
    Booking.findById.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        farmer: userId,
        advanceAmount: 200,
        advancePayment: 200,
      }),
    });

    const req = {
      user: { _id: userId, role: "farmer", wallet: undefined },
      params: { id: String(new mongoose.Types.ObjectId()) },
      body: { paymentMethod: "upi", transactionId: "txn_wallet_undef_1" },
    };
    const res = makeRes();
    const next = jest.fn();

    await controller.payAdvance(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(500);
    expect(next.mock.calls[0][0].message).toBe("Wallet not initialized");
  });

  test("payAdvance wallet guard throws 402 when wallet is below required amount", async () => {
    process.env.NODE_ENV = "development";
    process.env.ENABLE_WALLET_BALANCE_GUARD = "true";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const userId = new mongoose.Types.ObjectId();
    Booking.findById.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        farmer: userId,
        advanceAmount: 500,
        advancePayment: 500,
      }),
    });

    const req = {
      user: { _id: userId, role: "farmer", wallet: 100 },
      params: { id: String(new mongoose.Types.ObjectId()) },
      body: { paymentMethod: "upi", transactionId: "txn_wallet_low_1" },
    };
    const res = makeRes();
    const next = jest.fn();

    await controller.payAdvance(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(402);
    expect(next.mock.calls[0][0].message).toBe("Insufficient wallet balance");
  });
});
