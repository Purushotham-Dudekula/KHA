/**
 * razorpayStatus.service — fetchRazorpayPaymentStatus branches with mocked Razorpay SDK.
 */
jest.mock("razorpay", () => {
  return jest.fn().mockImplementation(() => ({
    payments: {
      fetch: jest.fn(),
    },
  }));
});

const Razorpay = require("razorpay");
const { fetchRazorpayPaymentStatus } = require("../../src/services/razorpayStatus.service");

describe("razorpayStatus.service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("failure: empty payment id", async () => {
    const out = await fetchRazorpayPaymentStatus("");
    expect(out.ok).toBe(false);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toMatch(/missing payment id/i);
  });

  test("failure: Razorpay not configured", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const out = await fetchRazorpayPaymentStatus("pay_x");
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/not configured/i);
  });

  test("success: returns status from API", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test";
    process.env.RAZORPAY_KEY_SECRET = "sec_test";

    const fetchMock = jest.fn().mockResolvedValue({ id: "pay_ok", status: "captured" });
    Razorpay.mockImplementation(() => ({
      payments: { fetch: fetchMock },
    }));

    const out = await fetchRazorpayPaymentStatus("pay_ok");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("captured");
    expect(fetchMock).toHaveBeenCalledWith("pay_ok");
  });

  test("failure: API throws — ok false with error", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test";
    process.env.RAZORPAY_KEY_SECRET = "sec_test";

    Razorpay.mockImplementation(() => ({
      payments: {
        fetch: jest.fn().mockRejectedValue(new Error("network down")),
      },
    }));

    const out = await fetchRazorpayPaymentStatus("pay_fail");
    expect(out.ok).toBe(false);
    expect(out.error).toBeInstanceOf(Error);
  });
});
