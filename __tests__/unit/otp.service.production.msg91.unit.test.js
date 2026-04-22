/**
 * otp.service binds `fetch` at load time (global.fetch || node-fetch).
 * Tests delete global.fetch and reset modules so MSG91 uses a mocked node-fetch.
 */
jest.mock("../../src/utils/requestContext", () => ({
  isRequestCancelled: jest.fn(() => false),
}));

jest.mock("node-fetch", () => jest.fn());

const savedFetch = global.fetch;

describe("otp.service production (MSG91 via node-fetch mock)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    if (savedFetch !== undefined) delete global.fetch;
  });

  afterEach(() => {
    if (savedFetch !== undefined) global.fetch = savedFetch;
    process.env = { ...originalEnv };
  });

  test("sendOTP returns msg91 channel when provider accepts", async () => {
    const nodeFetch = require("node-fetch");
    nodeFetch.mockReset();
    nodeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ type: "success" }),
    });
    const { sendOTP } = require("../../src/services/otp.service");
    process.env.NODE_ENV = "production";
    process.env.MSG91_AUTH_KEY = "key";
    process.env.MSG91_TEMPLATE_ID = "tpl";
    const out = await sendOTP("9999999999", "654321");
    expect(out.delivered).toBe(true);
    expect(out.channel).toBe("msg91");
    expect(nodeFetch).toHaveBeenCalledWith(
      "https://api.msg91.com/api/v5/otp",
      expect.objectContaining({ method: "POST" })
    );
  });

  test("sendOTP throws when provider json type is not success", async () => {
    const nodeFetch = require("node-fetch");
    nodeFetch.mockReset();
    nodeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ type: "error", message: "bad" }),
    });
    const { sendOTP } = require("../../src/services/otp.service");
    process.env.NODE_ENV = "production";
    process.env.MSG91_AUTH_KEY = "key";
    process.env.MSG91_TEMPLATE_ID = "tpl";
    await expect(sendOTP("9999999999", "111111")).rejects.toMatchObject({
      message: expect.stringMatching(/SMS/i),
    });
  });

  test("sendOTP wraps fetch rejection as AppError", async () => {
    const nodeFetch = require("node-fetch");
    nodeFetch.mockReset();
    nodeFetch.mockRejectedValue(new Error("network"));
    const { sendOTP } = require("../../src/services/otp.service");
    process.env.NODE_ENV = "production";
    process.env.MSG91_AUTH_KEY = "key";
    process.env.MSG91_TEMPLATE_ID = "tpl";
    await expect(sendOTP("9999999999", "222222")).rejects.toMatchObject({
      message: expect.stringMatching(/SMS/i),
    });
  });
});
