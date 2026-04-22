const mongoose = require("mongoose");
const Admin = require("../../models/admin.model");
const User = require("../../models/user.model");
const Tractor = require("../../models/tractor.model");
const Booking = require("../../models/booking.model");
const Complaint = require("../../models/complaint.model");
const Payment = require("../../models/payment.model");
const Pricing = require("../../models/pricing.model");
const Commission = require("../../models/commission.model");
const SeasonalPricing = require("../../models/seasonalPricing.model");
const AdminAuditLog = require("../../models/adminAuditLog.model");
const AdminActivityLog = require("../../models/adminActivityLog.model");
const { logAdminAction } = require("../../services/adminAuditLog.service");
const {
  hasOperatorDocumentsForApproval,
  validateTractorForApproval,
  deriveTractorVerificationFromDocuments,
} = require("../../utils/verification");
const { cleanUserResponse } = require("../../utils/cleanUserResponse");
const { sendSuccess } = require("../../utils/apiResponse");
const { logger } = require("../../utils/logger");
const { notifyUser } = require("../../services/notification.service");
const { refundUpiPayment } = require("../../services/payment.service");
const { logRefundSuccess } = require("../../services/ledger.service");
const { resolveRefundSnapshot } = require("../../utils/refundCalculation");
const { getSecureFileUrl } = require("../../services/storage.service");
const { AppError } = require("../../utils/AppError");
const { logAdminActivity } = require("../../services/adminActivityLog.service");
const { logAuditAction } = require("../../services/auditLog.service");
const { invalidateUserAuthCache } = require("../../middleware/auth.middleware");

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

async function getSecureOperatorDocument(req, res, next) {
  try {
    const { id, type } = req.params || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid operator id is required.");
    }

    const docType = typeof type === "string" ? type.trim().toLowerCase() : "";
    if (!["aadhaar", "license"].includes(docType)) {
      res.status(400);
      throw new Error('Invalid document type. Use "aadhaar" or "license".');
    }

    const user = await User.findById(id);
    if (!user || user.role !== "operator") {
      res.status(404);
      throw new Error("Operator not found.");
    }

    const documentUrl =
      docType === "aadhaar"
        ? String(user.aadhaarDocument || "").trim()
        : String(user.drivingLicenseDocument || "").trim();

    if (!documentUrl) {
      res.status(404);
      throw new Error("Document not found.");
    }

    const url = await getSecureFileUrl(documentUrl);
    return res.status(200).json({ success: true, url });
  } catch (error) {
    return next(error);
  }
}

async function verifyOperatorDocuments(req, res, next) {
  try {
    const { id } = req.params || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid operator id is required.");
    }

    const aadhaarStatus = typeof req.body?.aadhaarStatus === "string" ? req.body.aadhaarStatus.trim().toLowerCase() : "";
    const licenseStatus = typeof req.body?.licenseStatus === "string" ? req.body.licenseStatus.trim().toLowerCase() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    const valid = ["approved", "rejected"];
    if (!valid.includes(aadhaarStatus) || !valid.includes(licenseStatus)) {
      res.status(400);
      throw new Error('aadhaarStatus and licenseStatus must be "approved" or "rejected".');
    }

    const user = await User.findById(id);
    if (!user || user.role !== "operator") {
      res.status(404);
      throw new Error("Operator not found.");
    }

    // Update per-document verified flags.
    user.aadhaarVerified = aadhaarStatus === "approved";
    user.licenseVerified = licenseStatus === "approved";

    // Final verification status logic.
    if (user.aadhaarVerified && user.licenseVerified) {
      user.verificationStatus = "approved";
    } else if (aadhaarStatus === "rejected" || licenseStatus === "rejected") {
      user.verificationStatus = "rejected";
    } else {
      user.verificationStatus = "pending";
    }

    await user.save();

    // Notify operator after verification action.
    try {
      if (user.verificationStatus === "rejected") {
        await notifyUser({
          req,
          app: null,
          userId: user._id,
          title: "Document Rejected",
          message: reason || "Please re-upload valid documents",
          type: "alert",
        });
      } else if (user.verificationStatus === "approved") {
        await notifyUser({
          req,
          app: null,
          userId: user._id,
          title: "Verification Approved",
          message: "Your documents are verified",
          type: "alert",
        });
      }
    } catch {
      // Non-blocking: verification should succeed even if notification fails.
    }

    void logAdminActivity({
      adminId: req.admin?._id,
      action: "OPERATOR_DOCUMENTS_VERIFIED",
      targetId: user._id,
      targetType: "operator",
      metadata: {
        aadhaarVerified: Boolean(user.aadhaarVerified),
        licenseVerified: Boolean(user.licenseVerified),
        verificationStatus: user.verificationStatus,
      },
    });
    return sendSuccess(res, 200, "Operator documents verification updated.", {
      operatorId: user._id,
      aadhaarVerified: user.aadhaarVerified,
      licenseVerified: user.licenseVerified,
      verificationStatus: user.verificationStatus,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  verifyOperator,
  rejectOperator,
  getSecureOperatorDocument,
  verifyOperatorDocuments
};
