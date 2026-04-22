describe("storage.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("getSecureFileUrl -> throws when fileUrl missing", async () => {
    const { getSecureFileUrl } = require("../../../src/services/storage.service");
    await expect(getSecureFileUrl("")).rejects.toThrow(/fileUrl is required/i);
  });

  test("getSecureFileUrl -> cloudinary not configured -> 503 AppError", async () => {
    process.env.STORAGE_PROVIDER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "";
    process.env.CLOUDINARY_API_KEY = "";
    process.env.CLOUDINARY_API_SECRET = "";

    jest.doMock("cloudinary", () => ({ v2: { config: jest.fn(), url: jest.fn() } }));

    const { getSecureFileUrl } = require("../../../src/services/storage.service");
    await expect(getSecureFileUrl("https://res.cloudinary.com/demo/raw/upload/v1/file.pdf")).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test("getSecureFileUrl -> s3 dev without config returns original url", async () => {
    process.env.NODE_ENV = "development";
    process.env.STORAGE_PROVIDER = "s3";
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_BUCKET;
    const { getSecureFileUrl } = require("../../../src/services/storage.service");
    const url = "https://example.com/myfile.pdf";
    await expect(getSecureFileUrl(url)).resolves.toBe(url);
  });

  test("getSecureFileUrl -> cloudinary signed URL success", async () => {
    process.env.STORAGE_PROVIDER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "demo";
    process.env.CLOUDINARY_API_KEY = "k";
    process.env.CLOUDINARY_API_SECRET = "s";
    process.env.SIGNED_URL_EXPIRY = "600";

    jest.doMock("cloudinary", () => ({
      v2: {
        config: jest.fn(),
        url: jest.fn(() => "https://signed.cloudinary.example/url"),
      },
    }));

    const { getSecureFileUrl } = require("../../../src/services/storage.service");
    const out = await getSecureFileUrl("https://res.cloudinary.com/demo/raw/upload/v1/folder/file.pdf");
    expect(out).toContain("signed.cloudinary.example");
  });

  test("getSecureFileUrl -> cloudinary invalid URL -> 400 AppError", async () => {
    process.env.STORAGE_PROVIDER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "demo";
    process.env.CLOUDINARY_API_KEY = "k";
    process.env.CLOUDINARY_API_SECRET = "s";
    jest.doMock("cloudinary", () => ({ v2: { config: jest.fn(), url: jest.fn() } }));

    const { getSecureFileUrl } = require("../../../src/services/storage.service");
    await expect(getSecureFileUrl("https://example.com/not-cloudinary")).rejects.toMatchObject({ statusCode: 400 });
  });

  test("uploadFile -> throws when buffer missing", async () => {
    const { uploadFile } = require("../../../src/services/storage.service");
    await expect(uploadFile({ originalname: "x" })).rejects.toThrow(/requires a buffer/i);
  });

  test("uploadFile -> dev without S3 config returns dummy url", async () => {
    process.env.NODE_ENV = "development";
    process.env.STORAGE_PROVIDER = "s3";
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_BUCKET;

    const { uploadFile } = require("../../../src/services/storage.service");
    const r = await uploadFile({ buffer: Buffer.from("x"), originalname: "a.txt", mimetype: "text/plain" });
    expect(r).toEqual(expect.objectContaining({ mock: true, url: expect.stringContaining("dummy-storage.local") }));
  });

  test("uploadFile -> s3 configured uses aws client", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_PROVIDER = "s3";
    process.env.AWS_ACCESS_KEY_ID = "a";
    process.env.AWS_SECRET_ACCESS_KEY = "b";
    process.env.AWS_S3_BUCKET = "bucket1";
    process.env.AWS_REGION = "ap-south-1";

    jest.doMock("@aws-sdk/client-s3", () => ({
      S3Client: function S3Client() {
        return { send: jest.fn(async () => ({})) };
      },
      PutObjectCommand: function PutObjectCommand(input) {
        this.input = input;
      },
      GetObjectCommand: function GetObjectCommand(input) {
        this.input = input;
      },
    }));
    jest.doMock("@aws-sdk/s3-request-presigner", () => ({
      getSignedUrl: jest.fn(async () => "https://signed.s3.example/url"),
    }));
    jest.doMock("cloudinary", () => ({ v2: { config: jest.fn(), url: jest.fn() } }));
    jest.doMock("../../../src/services/cloudinary.service", () => ({ uploadFile: jest.fn() }));

    const { uploadFile } = require("../../../src/services/storage.service");
    const out = await uploadFile({ buffer: Buffer.from("x"), originalname: "a.txt", mimetype: "text/plain" });
    expect(out.mock).toBe(false);
    expect(out.url).toContain("amazonaws.com");
  });
});

