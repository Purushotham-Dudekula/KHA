/**
 * Remaining branch/line coverage for payment.service.js (complements existing payment.service*.test.js).
 */
jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("../../src/models/payment.model", () => ({
  exists: jest.fn(async () => false),
}));

jest.mock("razorpay", () => jest.fn());

const Razorpay = require("razorpay");
const { isRequestCancelled } = require("../../src/utils/requestContext");
const paymentService = require("../../src/services/payment.service");

describe("payment.service remaining branches", () => {
  const originalEnv = { ...process.env };
  const { createOrder, verifyPayment, fetchPaymentAmountRupees, refundUpiPayment } = paymentService;

  afterEach(() => {
    jest.clearAllMocks();
    isRequestCancelled.mockReturnValue(false);
    process.env = { ...originalEnv };
  });

  test("createOrder aborted when request cancelled", async () => {
    isRequestCancelled.mockReturnValue(true);
    await expect(createOrder(100)).rejects.toThrow(/aborted/i);
  });

  test("createOrder success returns Razorpay order", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      orders: {
        create: jest.fn().mockResolvedValue({ id: "order_1", amount: 10000 }),
      },
    }));
    const order = await createOrder(100);
    expect(order.id).toBe("order_1");
  });

  test("verifyPayment aborted when request cancelled", async () => {
    isRequestCancelled.mockReturnValue(true);
    await expect(verifyPayment({})).rejects.toThrow(/aborted/i);
  });

  test("verifyPayment logs when ALLOW_DEV_PAYMENT in non-development", async () => {
    const { logger } = require("../../src/utils/logger");
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => {});

    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_PAYMENT = "true";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";

    await verifyPayment({
      orderId: "o",
      paymentId: "p",
      signature: "x",
      razorpay_order_id: "o",
      razorpay_payment_id: "p",
      razorpay_signature: "bad",
    });

    expect(warn).toHaveBeenCalledWith(
      "Dev payment bypass ignored outside development",
      expect.objectContaining({ nodeEnv: "production" })
    );
    warn.mockRestore();
  });

  test("fetchPaymentAmountRupees production invalid amount from API", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockResolvedValue({ id: "p1", amount: "bad" }),
      },
    }));
    const out = await fetchPaymentAmountRupees("p1");
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/Invalid Razorpay payment amount/i);
  });

  test("fetchPaymentAmountRupees catch path returns ok:false", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockImplementation(() => {
          throw new Error("boom");
        }),
      },
    }));
    const out = await fetchPaymentAmountRupees("p2");
    expect(out.ok).toBe(false);
    expect(out.error.message).toBe("boom");
  });

  test("refundUpiPayment aborted", async () => {
    isRequestCancelled.mockReturnValue(true);
    const out = await refundUpiPayment("pay", 10);
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/aborted/i);
  });

  test("refundUpiPayment missing razorpay", async () => {
    isRequestCancelled.mockReturnValue(false);
    delete process.env.RAZORPAY_KEY_ID;
    const out = await refundUpiPayment("pay", 10);
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/not configured/i);
  });

  test("refundUpiPayment invalid amount", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: { refund: jest.fn() },
    }));
    const out = await refundUpiPayment("pay", 0);
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/Invalid refund amount/i);
  });

  test("refundUpiPayment API error", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: {
        refund: jest.fn().mockRejectedValue(new Error("refund rejected")),
      },
    }));
    const out = await refundUpiPayment("pay", 5);
    expect(out.ok).toBe(false);
    expect(out.error.message).toBe("refund rejected");
  });

  test("createOrder throws when Razorpay keys missing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await expect(createOrder(50)).rejects.toThrow(/not configured/i);
  });

  test("createOrder invalid amount (non-positive paise)", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({ orders: { create: jest.fn() } }));
    await expect(createOrder(0)).rejects.toThrow(/Invalid amount/i);
  });

  test("isPaymentIdReused with bookingId uses scoped query", async () => {
    const Payment = require("../../src/models/payment.model");
    const { isPaymentIdReused } = paymentService;
    const bid = "507f1f77bcf86cd7994390111";
    Payment.exists.mockResolvedValueOnce(true);
    await isPaymentIdReused("pay_scope", bid);
    expect(Payment.exists).toHaveBeenCalledWith({
      paymentId: "pay_scope",
      bookingId: { $ne: bid },
    });
  });

  test("fetchPaymentAmountRupees non-production uses console.warn path", async () => {
    const { logger } = require("../../src/utils/logger");
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.NODE_ENV = "test";
    const out = await fetchPaymentAmountRupees("any");
    expect(out.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("fetchPaymentAmountRupees production success returns rupees", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockResolvedValue({ id: "pok", amount: 5000 }),
      },
    }));
    const out = await fetchPaymentAmountRupees("pok");
    expect(out.ok).toBe(true);
    expect(out.amountRupees).toBe(50);
  });

  test("refundUpiPayment success", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    Razorpay.mockImplementation(() => ({
      payments: {
        refund: jest.fn().mockResolvedValue({ id: "rfnd_1" }),
      },
    }));
    const out = await refundUpiPayment("pay_x", 12.5);
    expect(out.ok).toBe(true);
    expect(out.refund.id).toBe("rfnd_1");
  });
});
