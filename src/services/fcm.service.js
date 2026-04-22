const fs = require("fs");
const path = require("path");
const { logger } = require("../utils/logger");

let initialized = false;
let firebaseAdmin = null;

const DEFAULT_KEY_FILENAME = "serviceAccountKey.json";

function isFcmEnabled() {
  return String(process.env.ENABLE_FIREBASE_FCM || "false").trim().toLowerCase() === "true";
}

function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    // Optional dependency: FCM is feature-flagged and non-critical.
    firebaseAdmin = require("firebase-admin");
    return firebaseAdmin;
  } catch {
    return null;
  }
}

/**
 * Resolves Firebase service account JSON path:
 * 1) `serviceAccountKey.json` in the project working directory (if the file exists)
 * 2) Else `FIREBASE_SERVICE_ACCOUNT_PATH` (absolute or relative to cwd)
 * Returns "" if nothing usable is found (caller skips init silently).
 */
function getServiceAccountPath() {
  const cwd = process.cwd();
  const defaultPath = path.join(cwd, DEFAULT_KEY_FILENAME);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  const envPath = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim();
  if (!envPath) return "";
  return path.isAbsolute(envPath) ? envPath : path.resolve(cwd, envPath);
}

function initFirebaseIfConfigured() {
  if (!isFcmEnabled()) {
    return false;
  }

  const admin = getFirebaseAdmin();
  if (!admin) {
    logger.warn("FCM disabled because firebase-admin is not installed");
    return false;
  }

  if (initialized || admin.apps.length > 0) {
    initialized = true;
    return true;
  }

  const serviceAccountPath = getServiceAccountPath();
  if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
    return false;
  }

  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initialized = true;
    logger.info("FCM initialized", { via: path.basename(serviceAccountPath) });
    return true;
  } catch (error) {
    logger.warn("FCM initialization failed", { message: error?.message });
    return false;
  }
}

async function sendPushNotification({ token, title, body, data }) {
  if (!token || typeof token !== "string" || !token.trim()) return false;
  if (!initFirebaseIfConfigured()) return false;

  try {
    const admin = getFirebaseAdmin();
    if (!admin) return false;
    await admin.messaging().send({
      token: token.trim(),
      notification: {
        title: title || "Notification",
        body: body || "",
      },
      data:
        data && typeof data === "object"
          ? Object.entries(data).reduce((acc, [k, v]) => {
              acc[String(k)] = String(v ?? "");
              return acc;
            }, {})
          : undefined,
    });
    return true;
  } catch (error) {
    logger.warn("FCM send failed", { message: error?.message });
    return false;
  }
}

module.exports = {
  initFirebaseIfConfigured,
  sendPushNotification,
};

