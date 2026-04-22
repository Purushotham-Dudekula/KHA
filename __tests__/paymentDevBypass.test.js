describe("Payment verification (dev bypass)", () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  const ORIGINAL_ALLOW_DEV_PAYMENT = process.env.ALLOW_DEV_PAYMENT;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    process.env.ALLOW_DEV_PAYMENT = ORIGINAL_ALLOW_DEV_PAYMENT;
    jest.resetModules();
  });

  test("verifyPayment bypasses when NODE_ENV != production", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { verifyPayment } = require("../src/services/payment.service");

    const res = await verifyPayment({
      orderId: "",
      paymentId: "",
      signature: "",
    });
    warn.mockRestore();

    expect(res).toEqual(
      expect.objectContaining({
        verified: true,
        message: "DEV MODE BYPASS",
      })
    );
  });

  test("verifyPayment throws in production when Razorpay not configured", async () => {
    process.env.NODE_ENV = "production";
    const { verifyPayment } = require("../src/services/payment.service");

    await expect(
      verifyPayment({
        orderId: "",
        paymentId: "",
        signature: "",
      })
    ).rejects.toThrow(/Payment service not configured/i);
  });
});

