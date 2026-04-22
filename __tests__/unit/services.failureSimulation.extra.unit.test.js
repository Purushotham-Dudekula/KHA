/**
 * Service-layer failure simulations: DB throw, Razorpay throw, request abort.
 */
jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("../../src/models/payment.model", () => ({
  exists: jest.fn(async () => false),
}));

jest.mock("razorpay", () => jest.fn());

const Razorpay = require("razorpay");
const Payment = require("../../src/models/payment.model");
const { isRequestCancelled } = require("../../src/utils/requestContext");
const {
  createOrder,
  verifyPayment,
  refundUpiPayment,
  fetchPaymentAmountRupees,
  isPaymentIdReused,
} = require("../../src/services/payment.service");

describe("services failure simulation (payment.service)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    isRequestCancelled.mockReturnValue(false);
  });

  test("createOrder: Razorpay orders.create throws — wrapped error", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";

    Razorpay.mockImplementation(() => ({
      orders: {
        create: jest.fn().mockRejectedValue(new Error("Razorpay outage")),
      },
    }));

    await expect(createOrder(100)).rejects.toThrow(/unable to create payment order/i);
  });

  test("verifyPayment: missing keys in production — throws", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    process.env.ALLOW_DEV_PAYMENT = "false";

    await expect(
      verifyPayment({ orderId: "o", paymentId: "p", signature: "x", razorpay_signature: "x", razorpay_order_id: "o", razorpay_payment_id: "p" })
    ).rejects.toThrow(/not configured/i);
  });

  test("refundUpiPayment: API throws — ok false", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";

    Razorpay.mockImplementation(() => ({
      payments: {
        refund: jest.fn().mockRejectedValue(new Error("refund failed")),
      },
    }));

    const out = await refundUpiPayment("pay_r1", 10);
    expect(out.ok).toBe(false);
    expect(out.error).toBeInstanceOf(Error);
  });

  test("fetchPaymentAmountRupees: request cancelled — ok false", async () => {
    isRequestCancelled.mockReturnValue(true);
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";

    const out = await fetchPaymentAmountRupees("pay_c1");
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/aborted/i);
  });

  test("isPaymentIdReused: database exists throws — propagates", async () => {
    Payment.exists.mockRejectedValueOnce(new Error("Simulated DB failure"));
    await expect(isPaymentIdReused("pay_db", null)).rejects.toThrow("Simulated DB failure");
  });
});
