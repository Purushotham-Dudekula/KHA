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
const { parsePagination } = require("../../utils/pagination");

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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

async function listPendingTractors(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100 });
    const filter = {
      verificationStatus: "pending",
      isDeleted: { $ne: true },
    };
    const total = await Tractor.countDocuments(filter);
    const tractors = await Tractor.find({
      verificationStatus: "pending",
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operatorId", "name village averageRating reviewCount phone")
      .lean();
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return sendSuccess(res, 200, "Pending tractors fetched.", {
      count: total,
      tractors,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function getSecureTractorDocument(req, res, next) {
  try {
    const { id, type } = req.params || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const docType = typeof type === "string" ? type.trim().toLowerCase() : "";
    const typeToField = {
      rc: "rcDocument",
      insurance: "insuranceDocument",
      pollution: "pollutionDocument",
      fitness: "fitnessDocument",
    };
    const field = typeToField[docType];
    if (!field) {
      res.status(400);
      throw new Error('Invalid document type. Use "rc", "insurance", "pollution", or "fitness".');
    }

    const tractor = await Tractor.findById(id).select(field).lean();
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    const documentUrl = tractor[field] != null ? String(tractor[field]).trim() : "";
    if (!documentUrl) {
      res.status(404);
      throw new Error("Document not found.");
    }

    const signedUrl = await getSecureFileUrl(documentUrl);
    return res.status(200).json({ success: true, url: signedUrl });
  } catch (error) {
    return next(error);
  }
}

async function verifyTractorDocument(req, res, next) {
  try {
    const { id } = req.params || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const documentType =
      typeof req.body?.documentType === "string" ? req.body.documentType.trim().toLowerCase() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    const statusFieldMap = {
      rc: "rcVerificationStatus",
      insurance: "insuranceVerificationStatus",
      pollution: "pollutionVerificationStatus",
      fitness: "fitnessVerificationStatus",
    };
    const reasonFieldMap = {
      rc: "rcVerificationReason",
      insurance: "insuranceVerificationReason",
      pollution: "pollutionVerificationReason",
      fitness: "fitnessVerificationReason",
    };

    const statusField = statusFieldMap[documentType];
    const reasonField = reasonFieldMap[documentType];
    if (!statusField || !reasonField) {
      res.status(400);
      throw new Error('Invalid documentType. Use "rc", "insurance", "pollution", or "fitness".');
    }
    if (!["approved", "rejected", "pending"].includes(status)) {
      res.status(400);
      throw new Error('status must be "approved", "rejected", or "pending".');
    }
    if (status === "rejected" && !reason) {
      res.status(400);
      throw new Error("reason is required when status is rejected.");
    }

    const tractor = await Tractor.findById(id);
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    tractor[statusField] = status;
    tractor[reasonField] = status === "rejected" ? reason : "";

    const derived = deriveTractorVerificationFromDocuments(tractor);
    tractor.verificationStatus = derived.verificationStatus;
    tractor.documentsVerified = derived.documentsVerified;
    await tractor.save();

    const title = status === "approved" ? "Document Approved" : "Document Rejected";
    const message =
      status === "approved"
        ? `Your ${documentType} document has been approved.`
        : `Your ${documentType} document was rejected${reason ? `: ${reason}` : "."}`;

    try {
      await notifyUser({
        req,
        app: null,
        userId: tractor.operatorId,
        title,
        message,
        type: "alert",
      });
    } catch {
      // Non-blocking: verification should succeed even if notification fails.
    }

    void logAdminActivity({
      adminId: req.admin?._id,
      action: status === "approved" ? "TRACTOR_DOCUMENT_APPROVED" : "TRACTOR_DOCUMENT_REJECTED",
      targetId: tractor._id,
      targetType: "tractor",
      metadata: { documentType, status },
    });
    return sendSuccess(res, 200, "Tractor document verification updated.", {
      tractorId: tractor._id,
      documentType,
      status: tractor[statusField],
      reason: tractor[reasonField] || null,
      verificationStatus: tractor.verificationStatus,
      documentsVerified: tractor.documentsVerified,
      tractor,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  verifyTractor,
  rejectTractor,
  listPendingTractors,
  getSecureTractorDocument,
  verifyTractorDocument
};
