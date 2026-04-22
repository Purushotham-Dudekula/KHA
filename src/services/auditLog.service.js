const mongoose = require("mongoose");
const AuditLog = require("../models/auditLog.model");
const { logger } = require("../utils/logger");

async function logAuditAction(userId, action) {
  try {
    if (!action || typeof action !== "string" || !action.trim()) return;
    const validUserId = userId && mongoose.Types.ObjectId.isValid(userId) ? userId : null;
    await AuditLog.create({
      userId: validUserId,
      action: action.trim(),
    });
  } catch (error) {
    logger.warn("Audit log write failed", { message: error?.message });
  }
}

module.exports = { logAuditAction };
