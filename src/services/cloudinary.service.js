const { v2: cloudinary } = require("cloudinary");
const { AppError } = require("../utils/AppError");
const { logger } = require("../utils/logger");

function requireCloudinaryEnv() {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || "").trim();

  if (!cloudName) throw new Error("Missing required environment variable: CLOUDINARY_CLOUD_NAME");
  if (!apiKey) throw new Error("Missing required environment variable: CLOUDINARY_API_KEY");
  if (!apiSecret) throw new Error("Missing required environment variable: CLOUDINARY_API_SECRET");

  return { cloudName, apiKey, apiSecret };
}

function configureCloudinary() {
  const { cloudName, apiKey, apiSecret } = requireCloudinaryEnv();
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

/**
 * Uploads a buffer-backed file to Cloudinary.
 * @param {object} file - Multer-style file: { buffer, originalname, mimetype }
 * @returns {Promise<{url: string, mock: false}>}
 */
async function uploadFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new Error("uploadFile requires a buffer.");
  }

  try {
    configureCloudinary();
  } catch (e) {
    throw new AppError(e?.message || "Cloudinary is not configured.", 503, {
      code: "CLOUDINARY_NOT_CONFIGURED",
      retryable: false,
    });
  }

  const original =
    typeof file.originalname === "string" && file.originalname.trim()
      ? file.originalname.trim()
      : "upload.bin";

  const safeName = original.replace(/[^\w.\-]+/g, "_");
  const base64 = file.buffer.toString("base64");
  const mime = file.mimetype || "application/octet-stream";
  const dataUri = `data:${mime};base64,${base64}`;

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      resource_type: "auto",
      filename_override: safeName,
      use_filename: true,
      unique_filename: true,
      overwrite: false,
    });

    if (!result?.secure_url) {
      throw new Error("Cloudinary upload did not return secure_url.");
    }

    return { url: String(result.secure_url), mock: false };
  } catch (err) {
    logger.error("Cloudinary upload failed", { message: err?.message });
    throw new AppError("Upload failed. Please try again.", 502, {
      code: "CLOUDINARY_UPLOAD_FAILED",
      retryable: true,
    });
  }
}

module.exports = { uploadFile };

