const path = require("path");
const dotenv = require("dotenv");
const { logger } = require("../utils/logger");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

function isTest() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function applyTestDefaults() {
  if (!isTest()) return;
  process.env.JWT_SECRET = (process.env.JWT_SECRET || "").trim() || "testsecret";
  process.env.MONGO_URI = (process.env.MONGO_URI || "").trim() || "mongodb://127.0.0.1:27017/testdb";
  process.env.REDIS_DISABLED = (process.env.REDIS_DISABLED || "").trim() || "true";
  process.env.JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "").trim() || "1h";
  process.env.CORS_ORIGIN = (process.env.CORS_ORIGIN || "").trim() || "http://localhost:3000";
}

function applyDevelopmentFallbacks() {
  if (!isDevelopment()) return;

  const fallbacks = {
    SMTP_HOST: "smtp.test.local",
    SMTP_PORT: "1025",
    SMTP_USER: "test",
    SMTP_PASS: "test",
  };

  let usedFallback = false;
  for (const [key, value] of Object.entries(fallbacks)) {
    const current = String(process.env[key] || "").trim();
    if (!current) {
      process.env[key] = value;
      usedFallback = true;
    }
  }

  if (usedFallback) {
    logger.warn("Using fallback env values in development");
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function isDevelopment() {
  return process.env.NODE_ENV === "development";
}

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function assertProductionIntegrationEnv() {
  if (!isProduction()) return;

  const allowDevPayment = String(process.env.ALLOW_DEV_PAYMENT || "")
    .trim()
    .toLowerCase();
  if (allowDevPayment === "true") {
    throw new Error("ALLOW_DEV_PAYMENT must be false in production");
  }

  const allowReconcileFallback = String(process.env.ALLOW_RECONCILE_FALLBACK || "")
    .trim()
    .toLowerCase();
  if (allowReconcileFallback === "true") {
    throw new Error("ALLOW_RECONCILE_FALLBACK must be false in production");
  }

  const jwtSecret = String(process.env.JWT_SECRET || "").trim();
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }

  const refreshTokenSecret = String(process.env.REFRESH_TOKEN_SECRET || "").trim();
  if (refreshTokenSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }

  const msg91AuthKey = String(process.env.MSG91_AUTH_KEY || "").trim();
  if (!msg91AuthKey) {
    throw new Error("FATAL: MSG91_AUTH_KEY is required in production");
  }

  const metricsSecret = String(process.env.METRICS_SECRET || "").trim();
  if (!metricsSecret) {
    throw new Error("METRICS_SECRET is required in production");
  }
}

function parseCorsOrigins() {
  const raw = String(process.env.CORS_ORIGIN || "http://localhost:3000").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyOptionalDefaults() {
  const defaults = {
    MONGO_MAX_POOL_SIZE: "50",
    MONGO_MIN_POOL_SIZE: "5",
    MONGO_SERVER_SELECTION_TIMEOUT: "5000",
    MONGO_SOCKET_TIMEOUT: "45000",
    MONGO_CONNECT_TIMEOUT: "10000",
    WORKER_CONCURRENCY_WEBHOOK: "5",
    WORKER_CONCURRENCY_PAYMENT: "3",
    WORKER_CONCURRENCY_NOTIFICATION: "10",
    WORKER_CONCURRENCY_EMAIL: "5",
    WORKER_CONCURRENCY_DEFAULT: "3",
  };

  for (const [key, fallback] of Object.entries(defaults)) {
    const current = String(process.env[key] || "").trim();
    if (!current) process.env[key] = fallback;
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: 5000,
  mongoUri: "",
  jwtSecret: "",
  jwtExpiresIn: "",
  /** User app access JWT (auth.controller); defaults match prior hardcoded values. */
  jwtAccessExpiresIn: "15m",
  /** User app refresh JWT + cookie/session alignment. */
  jwtRefreshExpiresIn: "7d",
  corsOrigins: [],
  devRouteSecret: process.env.DEV_ROUTE_SECRET || "",
  enablePayments: true,
  enableEmails: true,
  enableNotifications: true,
};

function validateEnv() {
  process.env.NODE_ENV = String(process.env.NODE_ENV || "development").trim() || "development";
  applyTestDefaults();
  applyDevelopmentFallbacks();
  applyOptionalDefaults();

  env.mongoUri = requireEnv("MONGO_URI");
  env.jwtSecret = requireEnv("JWT_SECRET");
  env.jwtExpiresIn = String(process.env.JWT_EXPIRES_IN || "1h").trim() || "1h";
  env.jwtAccessExpiresIn = String(process.env.JWT_ACCESS_EXPIRES_IN || "15m").trim() || "15m";
  env.jwtRefreshExpiresIn = String(process.env.JWT_REFRESH_EXPIRES_IN || "7d").trim() || "7d";

  const parsedPort = Number(process.env.PORT || 5000);
  env.port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5000;
  env.corsOrigins = parseCorsOrigins();
  assertProductionIntegrationEnv();
  if (!String(process.env.ENABLE_WALLET_BALANCE_GUARD || "").trim()) {
    process.env.ENABLE_WALLET_BALANCE_GUARD = isProduction() ? "true" : "false";
  }
  if (isProduction()) {
    requireEnv("REQUIRE_SECURE_DOCUMENTS");
    if (!String(process.env.CORS_ORIGIN || "").trim()) {
      logger.warn("CORS_ORIGIN is not set in production; default localhost origin will be used.");
    }
  }
  env.devRouteSecret = String(process.env.DEV_ROUTE_SECRET || "").trim();
  // Tri-state: explicit "false" disables; unset defaults to enabled (backward compatible).
  function triBool(name, defaultWhenUnset = true) {
    const v = String(process.env[name] ?? "").trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return defaultWhenUnset;
  }
  env.enablePayments = triBool("ENABLE_PAYMENTS", true);
  env.enableEmails = triBool("ENABLE_EMAILS", true);
  env.enableNotifications = triBool("ENABLE_NOTIFICATIONS", true);
}

function startupIntegrationStatus() {
  const redisDisabled = String(process.env.REDIS_DISABLED || "")
    .trim()
    .toLowerCase() === "true";
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpUser = String(process.env.SMTP_USER || process.env.MAIL_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || process.env.MAIL_PASS || "").trim();
  const smtpFrom = String(process.env.ADMIN_EMAIL_FROM || "").trim();
  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const razorpaySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  const msg91Key = String(process.env.MSG91_AUTH_KEY || "").trim();
  const msg91Template = String(process.env.MSG91_TEMPLATE_ID || "").trim();
  const storageProvider = String(process.env.STORAGE_PROVIDER || "s3")
    .trim()
    .toLowerCase();
  const hasS3 = Boolean(
    String(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || "").trim() &&
      String(process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET || "").trim() &&
      String(process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || "").trim()
  );
  const hasCloudinary = Boolean(
    String(process.env.CLOUDINARY_CLOUD_NAME || "").trim() &&
      String(process.env.CLOUDINARY_API_KEY || "").trim() &&
      String(process.env.CLOUDINARY_API_SECRET || "").trim()
  );
  const corsConfigured = Boolean(String(process.env.CORS_ORIGIN || "").trim());

  return {
    redis: {
      configured: !redisDisabled && Boolean(redisUrl),
      disabled: redisDisabled,
      warning: !redisDisabled && !redisUrl ? "REDIS_URL is missing" : "",
    },
    razorpay: {
      configured: Boolean(razorpayKeyId && razorpaySecret && webhookSecret),
      warning:
        razorpayKeyId && razorpaySecret && webhookSecret
          ? ""
          : "Razorpay env not fully configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET)",
    },
    smtp: {
      configured: Boolean(smtpHost && smtpUser && smtpPass && smtpFrom),
      warning:
        smtpHost && smtpUser && smtpPass && smtpFrom
          ? ""
          : "SMTP env not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS/ADMIN_EMAIL_FROM)",
    },
    otpSms: {
      configured: Boolean(msg91Key && msg91Template),
      warning: msg91Key && msg91Template ? "" : "MSG91 env not fully configured (MSG91_AUTH_KEY/MSG91_TEMPLATE_ID)",
    },
    storage: {
      configured:
        (storageProvider === "s3" && hasS3) || (storageProvider === "cloudinary" && hasCloudinary),
      warning:
        storageProvider === "cloudinary"
          ? hasCloudinary
            ? ""
            : "Cloudinary env not fully configured (CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET)"
          : hasS3
            ? ""
            : "S3 env not fully configured (AWS_ACCESS_KEY_ID|AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY|AWS_SECRET, AWS_S3_BUCKET|S3_BUCKET)",
    },
    cors: {
      configured: corsConfigured,
      warning: corsConfigured ? "" : "CORS_ORIGIN is not set; localhost default will be used",
    },
  };
}

module.exports = { env, validateEnv, isDevelopment, startupIntegrationStatus };
