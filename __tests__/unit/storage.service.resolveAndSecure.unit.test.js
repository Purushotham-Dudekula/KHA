describe("storage.service resolveDocumentInput + getSecureFileUrl branches", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  test("resolveDocumentInput returns trimmed string for non-buffer", async () => {
    const { resolveDocumentInput } = require("../../src/services/storage.service");
    await expect(resolveDocumentInput("  https://x/y  ")).resolves.toBe("https://x/y");
    await expect(resolveDocumentInput(null)).resolves.toBe("");
  });

  test("getSecureFileUrl throws when fileUrl empty", async () => {
    process.env.STORAGE_PROVIDER = "s3";
    process.env.NODE_ENV = "production";
    process.env.AWS_ACCESS_KEY_ID = "a";
    process.env.AWS_SECRET_ACCESS_KEY = "b";
    process.env.AWS_S3_BUCKET = "bucket";
    const { getSecureFileUrl } = require("../../src/services/storage.service");
    await expect(getSecureFileUrl("")).rejects.toThrow("fileUrl is required.");
  });

  test("getSecureFileUrl cloudinary branch rejects invalid public id", async () => {
    process.env.STORAGE_PROVIDER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "c";
    process.env.CLOUDINARY_API_KEY = "k";
    process.env.CLOUDINARY_API_SECRET = "s";
    const { getSecureFileUrl } = require("../../src/services/storage.service");
    await expect(getSecureFileUrl("https://example.com/not-cloudinary")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
