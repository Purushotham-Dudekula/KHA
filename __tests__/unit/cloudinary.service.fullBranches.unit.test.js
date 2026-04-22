describe("cloudinary.service", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("uploadFile throws without buffer", async () => {
    const { uploadFile } = require("../../src/services/cloudinary.service");
    await expect(uploadFile({ buffer: null })).rejects.toThrow("uploadFile requires a buffer.");
  });

  test("uploadFile maps missing env to AppError 503", async () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    const { uploadFile } = require("../../src/services/cloudinary.service");
    await expect(
      uploadFile({ buffer: Buffer.from("a"), originalname: "a.png", mimetype: "image/png" })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  test("uploadFile maps upload failure to AppError 502", async () => {
    process.env.CLOUDINARY_CLOUD_NAME = "c";
    process.env.CLOUDINARY_API_KEY = "k";
    process.env.CLOUDINARY_API_SECRET = "s";
    const cloudinary = require("cloudinary").v2;
    jest.spyOn(cloudinary.uploader, "upload").mockRejectedValue(new Error("net"));
    const { uploadFile } = require("../../src/services/cloudinary.service");
    await expect(
      uploadFile({ buffer: Buffer.from("a"), originalname: "a.png", mimetype: "image/png" })
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
