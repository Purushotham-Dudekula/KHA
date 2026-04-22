const crypto = require("crypto");
const Razorpay = require("razorpay");
const {
  verifyPayment,
  hasRazorpayKeys,
  isPaymentIdReused,
  fetchPaymentAmountRupees,
} = require("../../src/services/payment.service");

jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("../../src/models/payment.model", () => ({
  exists: jest.fn(),
}));

jest.mock("razorpay", () => jest.fn());

const Payment = require("../../src/models/payment.model");

describe("payment.service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("verifyPayment in development returns bypass result", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const out = await verifyPayment({});
    expect(out.verified).toBe(true);
    expect(out.message).toBe("DEV MODE BYPASS");
  });

  test("verifyPayment in production with invalid signature returns unverified", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    const orderId = "order_1";
    const paymentId = "pay_1";
    const wrongSig = "deadbeef";
    const out = await verifyPayment({
      orderId,
      paymentId,
      signature: wrongSig,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: wrongSig,
    });
    expect(out.verified).toBe(false);
  });

  test("verifyPayment in production with valid signature returns verified", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    const orderId = "order_1";
    const paymentId = "pay_1";
    const body = `${orderId}|${paymentId}`;
    const sig = crypto.createHmac("sha256", "secret").update(body).digest("hex");
    const out = await verifyPayment({
      orderId,
      paymentId,
      signature: sig,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sig,
    });
    expect(out.verified).toBe(true);
  });

  test("isPaymentIdReused delegates to Payment.exists", async () => {
    Payment.exists.mockResolvedValue(true);
    const reused = await isPaymentIdReused("pay_x", "507f1f77bcf86cd799439011");
    expect(reused).toBe(true);
    expect(Payment.exists).toHaveBeenCalled();
  });

  test("hasRazorpayKeys reflects env", () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    expect(hasRazorpayKeys()).toBe(false);
    process.env.RAZORPAY_KEY_ID = "a";
    process.env.RAZORPAY_KEY_SECRET = "b";
    expect(hasRazorpayKeys()).toBe(true);
  });

  test("fetchPaymentAmountRupees success case returns amount in rupees", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockResolvedValue({ id: "pay_123", amount: 12345 }),
      },
    }));

    const out = await fetchPaymentAmountRupees("pay_123");

    expect(Razorpay).toHaveBeenCalledWith({
      key_id: "key",
      key_secret: "secret",
    });
    expect(out).toEqual({
      ok: true,
      amountRupees: 123.45,
      raw: { id: "pay_123", amount: 12345 },
    });
  });

  test("fetchPaymentAmountRupees failure returns Razorpay error", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    const error = new Error("Razorpay fetch failed");
    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockRejectedValue(error),
      },
    }));

    const out = await fetchPaymentAmountRupees("pay_123");

    expect(out.ok).toBe(false);
    expect(out.error).toBe(error);
  });

  test("fetchPaymentAmountRupees invalid paymentId returns configuration error", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    const fetch = jest.fn();
    Razorpay.mockImplementation(() => ({
      payments: { fetch },
    }));

    const out = await fetchPaymentAmountRupees("");

    expect(out.ok).toBe(false);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toBe("Razorpay not configured or missing payment id.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
