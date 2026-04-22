const Razorpay = require("razorpay");
const { fetchPaymentAmountRupees } = require("../../src/services/payment.service");

jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("../../src/models/payment.model", () => ({
  exists: jest.fn(),
}));

jest.mock("razorpay", () => jest.fn());

describe("payment.service extra unit tests", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Success case -> returns amount in rupees", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";

    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockResolvedValue({ id: "pay_ok_1", amount: 9999 }),
      },
    }));

    const res = await fetchPaymentAmountRupees("pay_ok_1");
    expect(res).toEqual({
      ok: true,
      amountRupees: 99.99,
      raw: { id: "pay_ok_1", amount: 9999 },
    });
  });

  test("Razorpay failure -> returns ok:false", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";

    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockRejectedValue(new Error("Razorpay down")),
      },
    }));

    const res = await fetchPaymentAmountRupees("pay_fail_1");
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(Error);
    expect(res.error.message).toBe("Razorpay down");
  });

  test("Invalid paymentId -> returns validation error", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";

    const res = await fetchPaymentAmountRupees("");
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(Error);
    expect(res.error.message).toBe("Razorpay not configured or missing payment id.");
  });
});
