const mongoose = require("mongoose");
const AdminActivityLog = require("../models/adminActivityLog.model");
const { logger } = require("../utils/logger");

function sanitizeMetadata(value) {
  if (value == null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50);

  // Best-effort: strip obviously sensitive keys (case-insensitive).
  const out = {};
  const blacklist = new Set(["password", "otp", "token", "tokens", "jwt", "secret", "authorization"]);
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || "").toLowerCase();
    if (blacklist.has(key)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Non-blocking admin activity logger.
 * Never throw to caller. Safe to call without await.
 */
async function logAdminActivity({ adminId, action, targetId, targetType, metadata }) {
  try {
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return;
    }
    const act = typeof action === "string" ? action.trim() : "";
    if (!act) {
      return;
    }

    const doc = {
      adminId,
      action: act,
      targetId: targetId && mongoose.Types.ObjectId.isValid(targetId) ? targetId : null,
      targetType: typeof targetType === "string" && targetType.trim() ? targetType.trim() : null,
      metadata: sanitizeMetadata(metadata),
    };

    await AdminActivityLog.create(doc);
  } catch (e) {
    // Silent fail (non-blocking). Keep a lightweight server-side trace.
    logger.warn("[ADMIN_ACTIVITY] log failed", { error: e?.message || String(e) });
  }
}

module.exports = { logAdminActivity };

