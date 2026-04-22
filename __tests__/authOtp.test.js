const { generateSixDigitOtp } = require("../src/utils/otpCrypto");

describe("Auth OTP", () => {
  test("generates a 6-digit numeric OTP", () => {
    const otp = generateSixDigitOtp();
    expect(typeof otp).toBe("string");
    expect(otp).toMatch(/^\d{6}$/);
  });

  test("OTP range is 100000–999999", () => {
    for (let i = 0; i < 50; i++) {
      const n = Number(generateSixDigitOtp());
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });
});

