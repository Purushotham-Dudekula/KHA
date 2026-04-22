const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { AppError } = require("../utils/AppError");
const { uploadFile: cloudinaryUpload } = require("./cloudinary.service");
const { v2: cloudinary } = require("cloudinary");
const { logger } = require("../utils/logger");

const isDevelopment = () => process.env.NODE_ENV === "development";
const isProduction = () => String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

function bucketName() {
  const b = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
  return b && String(b).trim() ? String(b).trim() : "";
}

function storageProvider() {
  return String(process.env.STORAGE_PROVIDER || "s3")
    .trim()
    .toLowerCase();
}

function hasS3ConfigWithAliases() {
  const access = (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || "").trim();
  const secret = (process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET || "").trim();
  return Boolean(access && secret && bucketName());
}

function getS3Client() {
  if (!hasS3ConfigWithAliases()) return null;
  const accessKeyId = String(
    process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || ""
  ).trim();
  const secretAccessKey = String(
    process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET || ""
  ).trim();
  return new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function configureCloudinaryIfPossible() {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || "").trim();
  if (!cloudName || !apiKey || !apiSecret) return false;

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  return true;
}

function extractCloudinaryPublicId(fileUrl) {
  if (!fileUrl || typeof fileUrl !== "string") return "";
  let u;
  try {
    u = new URL(fileUrl);
  } catch {
    return "";
  }

  // Typical patterns:
  // - /<cloud_name>/<resource_type>/upload/v123/folder/name.ext
  // - /<cloud_name>/<resource_type>/upload/folder/name.ext
  // We need the "public_id" => folder/name (no extension), and we sign as resource_type="raw".
  const path = decodeURIComponent(u.pathname || "");
  const idx = path.indexOf("/upload/");
  if (idx === -1) return "";
  let after = path.slice(idx + "/upload/".length);
  after = after.replace(/^v\d+\//, ""); // strip version if present
  after = after.replace(/^\/+/, "");
  if (!after) return "";
  // Remove extension (Cloudinary public_id doesn't include it)
  const lastDot = after.lastIndexOf(".");
  if (lastDot > after.lastIndexOf("/")) {
    after = after.slice(0, lastDot);
  }
  return after;
}

function extractS3KeyFromUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== "string") return "";
  let u;
  try {
    u = new URL(fileUrl);
  } catch {
    return "";
  }
  // Key is everything after the leading "/"
  const rawKey = (u.pathname || "").replace(/^\/+/, "");
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

/**
 * Returns a short-lived signed URL for secure admin access.
 * - Cloudinary: authenticated signed URL (resource_type="raw")
 * - S3: GetObject signed URL
 *
 * IMPORTANT: does not change upload/resolve behavior.
 */
async function getSecureFileUrl(fileUrl) {
  const expiry = Number(process.env.SIGNED_URL_EXPIRY || 600);
  const expiresIn = Number.isFinite(expiry) && expiry > 0 ? expiry : 600;
  const provider = storageProvider();
  const requireSecureDocs =
    String(process.env.REQUIRE_SECURE_DOCUMENTS || "")
      .trim()
      .toLowerCase() === "true";

  if (!fileUrl || typeof fileUrl !== "string" || !fileUrl.trim()) {
    throw new Error("fileUrl is required.");
  }

  if (provider === "cloudinary") {
    const ok = configureCloudinaryIfPossible();
    if (!ok) {
      throw new AppError("Cloudinary is not configured.", 503, {
        code: "CLOUDINARY_NOT_CONFIGURED",
        retryable: false,
      });
    }

    const publicId = extractCloudinaryPublicId(fileUrl);
    if (!publicId) {
      throw new AppError("Invalid Cloudinary file URL.", 400, {
        code: "INVALID_CLOUDINARY_URL",
        retryable: false,
      });
    }

    // Validation: detect publicly accessible Cloudinary delivery URLs.
    try {
      const u = new URL(fileUrl);
      const p = u.pathname || "";
      const looksPublic = p.includes("/upload/") && !p.includes("/authenticated/");
      if (looksPublic) {
        logger.error("Cloudinary document URL appears publicly accessible; prefer authenticated delivery", {
          host: u.host,
          path: p,
        });
        if (requireSecureDocs) {
          throw new AppError("Document URL is not secure", 403, {
            code: "INSECURE_DOCUMENT_STORAGE",
            retryable: false,
          });
        }
      }
    } catch {
      // ignore
    }

    const signedUrl = cloudinary.url(publicId, {
      resource_type: "raw",
      type: "authenticated",
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    });

    return signedUrl;
  }

  if (provider === "s3") {
    if (!hasS3ConfigWithAliases()) {
      // Keep dev usability: return original URL if storage isn't configured.
      if (isDevelopment()) return fileUrl;
      throw new AppError("S3 storage not configured.", 503, {
        code: "STORAGE_NOT_CONFIGURED",
        retryable: false,
      });
    }
    const key = extractS3KeyFromUrl(fileUrl);
    if (!key) {
      throw new AppError("Invalid S3 file URL.", 400, {
        code: "INVALID_S3_URL",
        retryable: false,
      });
    }

    // Validation: detect URL patterns that are likely to be public (unsigned object URLs).
    let s3UrlLooksPublic = false;
    try {
      const u = new URL(fileUrl);
      const host = String(u.hostname || "").toLowerCase();
      const hasSig =
        u.searchParams.has("X-Amz-Signature") ||
        u.searchParams.has("X-Amz-Credential") ||
        u.searchParams.has("X-Amz-Date");
      const looksLikeS3Host = host.includes("amazonaws.com") || host.includes(".s3.");
      s3UrlLooksPublic = looksLikeS3Host && !hasSig;
    } catch {
      s3UrlLooksPublic = false;
    }

    if (s3UrlLooksPublic) {
      logger.error("S3 document URL appears unsigned (potentially publicly addressable); use signed URLs and private bucket policy", {
        urlHost: (() => {
          try { return new URL(fileUrl).hostname; } catch { return ""; }
        })(),
      });
      if (requireSecureDocs) {
        throw new AppError("Document URL is not secure", 403, {
          code: "INSECURE_DOCUMENT_STORAGE",
          retryable: false,
        });
      }
    }

    // Validation-only: warn if app is configured to build/return public S3 URLs.
    if (process.env.AWS_S3_PUBLIC_URL_BASE && String(process.env.AWS_S3_PUBLIC_URL_BASE).trim()) {
      logger.warn("S3 public URL base is set; ensure bucket/object access is private and use signed URLs for documents", {
        base: String(process.env.AWS_S3_PUBLIC_URL_BASE).trim(),
      });
    }
    const bucket = bucketName();
    const client = getS3Client();
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const signedUrl = await getSignedUrl(client, cmd, { expiresIn });
    return signedUrl;
  }

  // Unknown provider -> safest fallback is original URL.
  return fileUrl;
}

/**
 * @param {object} file - Multer-style file: { buffer, originalname, mimetype }
 */
async function uploadFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new Error("uploadFile requires a buffer.");
  }

  if ((process.env.STORAGE_PROVIDER || "").trim().toLowerCase() === "cloudinary") {
    const r = await cloudinaryUpload(file);
    // Preserve existing return format used by S3 path.
    return { url: r.url, key: null, bucket: null, mock: false };
  }

  const original =
    typeof file.originalname === "string" && file.originalname.trim()
      ? file.originalname.trim()
      : "upload.bin";
  const safeName = original.replace(/[^\w.\-]+/g, "_");
  const key = `uploads/${Date.now()}_${safeName}`;

  if (!hasS3ConfigWithAliases()) {
    if (isDevelopment()) {
      const dummy = `https://dummy-storage.local/${key}`;
      return { url: dummy, key: null, bucket: null, mock: true };
    }
    throw new AppError(
      "File storage not configured. Set AWS_ACCESS_KEY_ID (or AWS_ACCESS_KEY), AWS_SECRET_ACCESS_KEY (or AWS_SECRET), and AWS_S3_BUCKET.",
      503,
      { code: "STORAGE_NOT_CONFIGURED", retryable: false }
    );
  }

  const bucket = bucketName();
  const client = getS3Client();
  const contentType = file.mimetype || "application/octet-stream";

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: contentType,
    })
  );

  const region = process.env.AWS_REGION || "ap-south-1";
  const base = process.env.AWS_S3_PUBLIC_URL_BASE
    ? String(process.env.AWS_S3_PUBLIC_URL_BASE).replace(/\/$/, "")
    : `https://${bucket}.s3.${region}.amazonaws.com`;
  const pathPart = key.split("/").map(encodeURIComponent).join("/");
  const url = `${base}/${pathPart}`;

  // Validation-only: warn if uploads are being addressed via public URL pattern.
  if (base.includes("amazonaws.com")) {
    logger.warn("S3 upload returned a direct object URL; ensure bucket policy blocks public reads and use signed URLs for document access", {
      bucket,
      key,
    });
  }

  return { url, key, bucket, mock: false };
}

/**
 * Keeps string URLs unchanged; uploads buffer-backed Multer files to S3 when configured.
 */
async function resolveDocumentInput(value) {
  if (value && typeof value === "object" && Buffer.isBuffer(value.buffer)) {
    const r = await uploadFile(value);
    return r.url;
  }
  return value != null ? String(value).trim() : "";
}

module.exports = {
  uploadFile,
  resolveDocumentInput,
  hasS3Config: hasS3ConfigWithAliases,
  getSecureFileUrl,
};
