jest.mock("../../../src/models/payment.model", () => ({
  exists: jest.fn(),
}));
jest.mock("../../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(),
}));

const Payment = require("../../../src/models/payment.model");
const { isRequestCancelled } = require("../../../src/utils/requestContext");

describe("payment.service (more unit)", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterAll(() => {
    process.env = { ...envBackup };
  });

  test("createOrder throws when cancelled", async () => {
    isRequestCancelled.mockReturnValueOnce(true);
    const { createOrder } = require("../../../src/services/payment.service");
    await expect(createOrder(10)).rejects.toThrow(/aborted/i);
  });

  test("createOrder throws when keys missing", async () => {
    isRequestCancelled.mockReturnValue(false);
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const { createOrder } = require("../../../src/services/payment.service");
    await expect(createOrder(10)).rejects.toThrow(/not configured/i);
  });

  test("verifyPayment returns false message when missing fields", async () => {
    isRequestCancelled.mockReturnValue(false);
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    const { verifyPayment } = require("../../../src/services/payment.service");
    const out = await verifyPayment({});
    expect(out.verified).toBe(false);
  });

  test("verifyPayment dev bypass true", async () => {
    isRequestCancelled.mockReturnValue(false);
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const { verifyPayment } = require("../../../src/services/payment.service");
    const out = await verifyPayment({ orderId: "o", paymentId: "p", signature: "x" });
    expect(out.verified).toBe(true);
  });

  test("fetchPaymentAmountRupees returns dev skip result", async () => {
    isRequestCancelled.mockReturnValue(false);
    process.env.NODE_ENV = "development";
    const { fetchPaymentAmountRupees } = require("../../../src/services/payment.service");
    const out = await fetchPaymentAmountRupees("pay_1");
    expect(out.ok).toBe(true);
  });

  test("refundUpiPayment invalid amount", async () => {
    isRequestCancelled.mockReturnValue(false);
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    jest.doMock("razorpay", () => {
      return function Razorpay() {
        return { payments: { refund: jest.fn() } };
      };
    });
    const { refundUpiPayment } = require("../../../src/services/payment.service");
    const out = await refundUpiPayment("pay_1", 0);
    expect(out.ok).toBe(false);
  });

  test("isPaymentIdReused false when empty", async () => {
    const { isPaymentIdReused } = require("../../../src/services/payment.service");
    await expect(isPaymentIdReused("")).resolves.toBe(false);
  });

  test("isPaymentIdReused true when exists", async () => {
    Payment.exists.mockResolvedValueOnce({ _id: "x" });
    const { isPaymentIdReused } = require("../../../src/services/payment.service");
    await expect(isPaymentIdReused("p1", "b1")).resolves.toBe(true);
  });
});

