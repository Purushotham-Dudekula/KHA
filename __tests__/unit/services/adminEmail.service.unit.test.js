describe("adminEmail.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("hasAdminSmtpConfig -> false when missing host/from", () => {
    process.env.SMTP_HOST = "";
    process.env.ADMIN_EMAIL_FROM = "";
    const { hasAdminSmtpConfig } = require("../../../src/services/adminEmail.service");
    expect(hasAdminSmtpConfig()).toBe(false);
  });

  test("deliverAdminLoginOtp -> throws 503 when not configured", async () => {
    process.env.SMTP_HOST = "";
    process.env.ADMIN_EMAIL_FROM = "";
    const { deliverAdminLoginOtp } = require("../../../src/services/adminEmail.service");
    await expect(deliverAdminLoginOtp("a@b.com", "1234")).rejects.toMatchObject({ statusCode: 503 });
  });

  test("deliverAdminLoginOtp -> success when nodemailer sends", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ADMIN_EMAIL_FROM = "noreply@example.com";

    jest.doMock("nodemailer", () => ({
      createTransport: () => ({ sendMail: jest.fn().mockResolvedValueOnce(true) }),
    }));

    const { deliverAdminLoginOtp } = require("../../../src/services/adminEmail.service");
    await expect(deliverAdminLoginOtp("a@b.com", "1234")).resolves.toBeUndefined();
  });

  test("deliverAdminLoginOtp -> wraps non-AppError send failure as 502", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ADMIN_EMAIL_FROM = "noreply@example.com";

    jest.doMock("nodemailer", () => ({
      createTransport: () => ({ sendMail: jest.fn().mockRejectedValueOnce(new Error("smtp down")) }),
    }));

    const { deliverAdminLoginOtp } = require("../../../src/services/adminEmail.service");
    await expect(deliverAdminLoginOtp("a@b.com", "1234")).rejects.toMatchObject({ statusCode: 502 });
  });
});

