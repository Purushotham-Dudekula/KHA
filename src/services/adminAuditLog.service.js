const mongoose = require("mongoose");
const AdminAuditLog = require("../models/adminAuditLog.model");
const { logger } = require("../utils/logger");

/**
 * Best-effort admin action audit logging.
 * Should never block primary business flow on logging failure.
 */
async function logAdminAction(adminId, action, targetId = null, metadata = null) {
  try {
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) return;
    if (!action || typeof action !== "string" || !action.trim()) return;

    const payload = {
      adminId,
      action: action.trim(),
      targetId: targetId && mongoose.Types.ObjectId.isValid(targetId) ? targetId : null,
      metadata: metadata && typeof metadata === "object" ? metadata : null,
    };

    await AdminAuditLog.create(payload);
  } catch (error) {
    logger.warn("Admin audit log write failed", { message: error?.message });
  }
}

module.exports = { logAdminAction };

