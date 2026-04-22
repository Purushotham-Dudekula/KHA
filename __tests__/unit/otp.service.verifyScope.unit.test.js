/**
 * otp.service.js only sends SMS (MSG91) — it does not generate OTPs or verify them.
 * Wrong OTP, expiry, and max attempts are enforced in auth / user models; cover those via auth tests.
 * This file: dev dispatch success, hasMsg91Keys edge cases.
 */
const { sendOTP, hasMsg91Keys } = require("../../src/services/otp.service");

describe("otp.service (SMS dispatch scope)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("non-production sendOTP succeeds (simulated SMS / dev channel)", async () => {
    process.env.NODE_ENV = "development";
    const out = await sendOTP("99999 99999", "123456");
    expect(out.delivered).toBe(true);
    expect(out.channel).toBe("dev");
  });

  test("hasMsg91Keys is false when key or template is whitespace-only", () => {
    process.env.MSG91_AUTH_KEY = "   ";
    process.env.MSG91_TEMPLATE_ID = "t";
    expect(hasMsg91Keys()).toBe(false);
    process.env.MSG91_AUTH_KEY = "k";
    process.env.MSG91_TEMPLATE_ID = "  ";
    expect(hasMsg91Keys()).toBe(false);
  });
});
