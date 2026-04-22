const { uploadFile } = require("./storage.service");
const { logger } = require("../utils/logger");

const fetchImpl = global.fetch || require("node-fetch");
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_DIMENSION = 300;
const MAX_DIMENSION = 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

let sharpLoader = null;
function getSharp() {
  if (sharpLoader !== null) return sharpLoader;
  try {
    // Lazy-load to keep module boot safe on older local runtimes.
    // Production target for this project is Node 20+, where sharp is supported.
    sharpLoader = require("sharp");
  } catch {
    sharpLoader = undefined;
  }
  return sharpLoader;
}

function looksLikeUrl(s) {
  try {
    const u = new URL(String(s || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPublicNonExpiringUrl(s) {
  try {
    const u = new URL(String(s || "").trim());
    const host = String(u.hostname || "").toLowerCase();
    const blockedParams = ["x-amz-signature", "x-amz-credential", "x-amz-date", "expires", "signature"];
    for (const p of blockedParams) {
      if (u.searchParams.has(p)) return false;
    }
    return (
      host.includes("res.cloudinary.com") ||
      host.includes("amazonaws.com") ||
      host.includes("cloudfront.net") ||
      host.includes("cdn")
    );
  } catch {
    return false;
  }
}

async function warnIfUrlLooksBad(url, context = {}) {
  const s = String(url || "").trim();
  if (!s) return;
  if (!looksLikeUrl(s)) {
    logger.warn("Service image URL is invalid format", context);
    return;
  }
  if (!isPublicNonExpiringUrl(s)) {
    logger.warn("Service image URL may be expiring/private", context);
  }
  try {
    const res = await fetchImpl(s, { method: "HEAD" });
    if (!res || res.status >= 400) {
      logger.warn("Service image URL is not publicly reachable", {
        ...context,
        status: res ? res.status : null,
      });
    }
  } catch {
    logger.warn("Service image URL reachability check failed", context);
  }
}

function parseDataUri(input) {
  const s = String(input || "").trim();
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const mime = String(m[1]).toLowerCase();
  const buffer = Buffer.from(m[2], "base64");
  return { mime, buffer };
}

async function optimizeImageBuffer(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Invalid image format or size");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Invalid image format or size");
  }
  if (!ALLOWED_MIME.has(String(mime || "").toLowerCase())) {
    throw new Error("Invalid image format or size");
  }

  const sharp = getSharp();
  if (!sharp) {
    throw new Error("Invalid image format or size");
  }
  const img = sharp(buffer, { failOnError: true });
  const meta = await img.metadata();
  const w = Number(meta.width || 0);
  const h = Number(meta.height || 0);
  if (!w || !h || w < MIN_DIMENSION || h < MIN_DIMENSION) {
    throw new Error("Invalid image format or size");
  }

  const resized = img.resize({
    width: MAX_DIMENSION,
    height: MAX_DIMENSION,
    fit: "inside",
    withoutEnlargement: true,
  });

  const out = await resized.webp({ quality: 80, effort: 4 }).toBuffer();
  if (!out || out.length === 0 || out.length > MAX_IMAGE_BYTES) {
    throw new Error("Invalid image format or size");
  }
  return out;
}

async function resolveServiceImageInput(input, context = {}) {
  if (input == null) return "";
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return "";
    const data = parseDataUri(s);
    if (!data) {
      await warnIfUrlLooksBad(s, context);
      return s;
    }
    const optimized = await optimizeImageBuffer(data.buffer, data.mime);
    const uploaded = await uploadFile({
      buffer: optimized,
      originalname: "service-image.webp",
      mimetype: "image/webp",
    });
    await warnIfUrlLooksBad(uploaded?.url, context);
    return String(uploaded?.url || "").trim();
  }
  if (typeof input === "object" && Buffer.isBuffer(input.buffer)) {
    const mime = String(input.mimetype || "").toLowerCase();
    const optimized = await optimizeImageBuffer(input.buffer, mime);
    const uploaded = await uploadFile({
      buffer: optimized,
      originalname: "service-image.webp",
      mimetype: "image/webp",
    });
    await warnIfUrlLooksBad(uploaded?.url, context);
    return String(uploaded?.url || "").trim();
  }
  throw new Error("Invalid image format or size");
}

module.exports = {
  resolveServiceImageInput,
};
