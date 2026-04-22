const { sendOTP, hasMsg91Keys } = require("../../src/services/otp.service");
const requestContext = require("../../src/utils/requestContext");

jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

describe("otp.service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    requestContext.isRequestCancelled.mockImplementation(() => false);
  });

  test("hasMsg91Keys returns false when keys missing", () => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    expect(hasMsg91Keys()).toBe(false);
  });

  test("hasMsg91Keys returns true when both keys set", () => {
    process.env.MSG91_AUTH_KEY = "k";
    process.env.MSG91_TEMPLATE_ID = "t";
    expect(hasMsg91Keys()).toBe(true);
  });

  test("sendOTP in non-production simulates dispatch without throwing", async () => {
    process.env.NODE_ENV = "development";
    const out = await sendOTP("9999999999", "123456");
    expect(out.delivered).toBe(true);
    expect(out.channel).toBe("dev");
  });

  test("sendOTP in production without MSG91 throws AppError", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    await expect(sendOTP("9999999999", "123456")).rejects.toMatchObject({
      message: expect.stringMatching(/SMS|configured/i),
    });
  });

  test("sendOTP throws 408 when request cancelled before provider call", async () => {
    requestContext.isRequestCancelled.mockReturnValueOnce(true);
    await expect(sendOTP("9999999999", "123456")).rejects.toMatchObject({
      statusCode: 408,
    });
  });
});
