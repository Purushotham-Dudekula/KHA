/**
 * payment.service verifyPayment logs info on attempt (production path).
 */
jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("../../src/models/payment.model", () => ({
  exists: jest.fn(),
}));

const { logger } = require("../../src/utils/logger");
const { verifyPayment } = require("../../src/services/payment.service");

describe("logger invocation (payment verifyPayment)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("production verify attempt logs logger.info", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.ALLOW_DEV_PAYMENT = "false";

    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});

    await verifyPayment({
      orderId: "o1",
      paymentId: "p1",
      signature: "sig",
      razorpay_order_id: "o1",
      razorpay_payment_id: "p1",
      razorpay_signature: "wrong",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "Payment verification attempt",
      expect.objectContaining({
        nodeEnv: "production",
        hasOrderId: true,
        hasPaymentId: true,
        hasSignature: true,
      })
    );

    infoSpy.mockRestore();
  });

  test("development bypass logs logger.warn", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";

    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});

    await verifyPayment({});

    expect(warnSpy).toHaveBeenCalledWith("DEV MODE: Skipping Razorpay verification");

    warnSpy.mockRestore();
  });
});
