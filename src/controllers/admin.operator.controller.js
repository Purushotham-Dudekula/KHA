const mongoose = require("mongoose");
const User = require("../models/user.model");
const Tractor = require("../models/tractor.model");
const { logAuditAction } = require("../services/auditLog.service");
const { logAdminActivity } = require("../services/adminActivityLog.service");
const {
  hasOperatorDocumentsForApproval,
  validateTractorForApproval,
} = require("../utils/verification");
const { cleanUserResponse } = require("../utils/cleanUserResponse");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");

async function verifyOperator(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid operator id is required.");
    }
    const user = await User.findById(id);
    if (!user || user.role !== "operator") {
      res.status(404);
      throw new Error("Operator not found.");
    }
    if (!hasOperatorDocumentsForApproval(user)) {
      res.status(400);
      throw new Error("Operator does not meet verification requirements.");
    }
    user.verificationStatus = "approved";
    user.aadhaarVerified = true;
    user.licenseVerified = true;
    await user.save();
    logger.info(`[EVENT] Admin verify operator: ${user._id.toString()}`);
    void logAuditAction(req.admin?._id, "ADMIN_APPROVAL_VERIFY_OPERATOR");
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "OPERATOR_APPROVED",
      targetId: user._id,
      targetType: "operator",
      metadata: { verificationStatus: user.verificationStatus },
    });
    return sendSuccess(res, 200, "Operator verified.", { user: cleanUserResponse(user) });
  } catch (error) {
    return next(error);
  }
}

async function rejectOperator(req, res, next) {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid operator id is required.");
    }
    const user = await User.findById(id);
    if (!user || user.role !== "operator") {
      res.status(404);
      throw new Error("Operator not found.");
    }
    user.verificationStatus = "rejected";
    user.aadhaarVerified = false;
    user.licenseVerified = false;
    await user.save();
    logger.info(`[EVENT] Admin reject operator: ${user._id.toString()}`);
    void logAuditAction(req.admin?._id, "ADMIN_APPROVAL_REJECT_OPERATOR");
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "OPERATOR_REJECTED",
      targetId: user._id,
      targetType: "operator",
      metadata: { verificationStatus: user.verificationStatus },
    });
    return sendSuccess(res, 200, "Operator rejected.", {
      reason: reason || null,
      user: cleanUserResponse(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function verifyTractor(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }
    const tractor = await Tractor.findById(id);
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }
    const { ok, missing } = validateTractorForApproval(tractor);
    if (!ok) {
      res.status(400);
      throw new Error(`Cannot verify tractor. Missing/invalid: ${missing.join(", ")}.`);
    }
    tractor.verificationStatus = "approved";
    tractor.documentsVerified = true;
    tractor.rcVerificationStatus = "approved";
    tractor.insuranceVerificationStatus = "approved";
    tractor.pollutionVerificationStatus = "approved";
    tractor.fitnessVerificationStatus = "approved";
    tractor.rcVerificationReason = "";
    tractor.insuranceVerificationReason = "";
    tractor.pollutionVerificationReason = "";
    tractor.fitnessVerificationReason = "";
    await tractor.save();
    logger.info(`[EVENT] Admin verify tractor: ${tractor._id.toString()}`);
    void logAuditAction(req.admin?._id, "ADMIN_APPROVAL_VERIFY_TRACTOR");
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "TRACTOR_VERIFIED",
      targetId: tractor._id,
      targetType: "tractor",
      metadata: { verificationStatus: tractor.verificationStatus },
    });
    return sendSuccess(res, 200, "Tractor verified.", { tractor });
  } catch (error) {
    return next(error);
  }
}

async function rejectTractor(req, res, next) {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }
    const tractor = await Tractor.findById(id);
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }
    tractor.verificationStatus = "rejected";
    tractor.documentsVerified = false;
    tractor.rcVerificationStatus = "rejected";
    tractor.insuranceVerificationStatus = "rejected";
    tractor.pollutionVerificationStatus = "rejected";
    tractor.fitnessVerificationStatus = "rejected";
    if (reason) {
      tractor.rcVerificationReason = reason;
      tractor.insuranceVerificationReason = reason;
      tractor.pollutionVerificationReason = reason;
      tractor.fitnessVerificationReason = reason;
    }
    await tractor.save();
    logger.info(`[EVENT] Admin reject tractor: ${tractor._id.toString()}`);
    void logAuditAction(req.admin?._id, "ADMIN_APPROVAL_REJECT_TRACTOR");
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "TRACTOR_REJECTED",
      targetId: tractor._id,
      targetType: "tractor",
      metadata: { verificationStatus: tractor.verificationStatus },
    });
    return sendSuccess(res, 200, "Tractor rejected.", { reason: reason || null, tractor });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  verifyOperator,
  rejectOperator,
  verifyTractor,
  rejectTractor,
};
