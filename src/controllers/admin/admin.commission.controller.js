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

async function upsertCommission(req, res, next) {
  try {
    const { percentage, active } = req.body || {};

    if (percentage === undefined || percentage === null || percentage === "") {
      res.status(400);
      throw new Error("percentage is required.");
    }

    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      res.status(400);
      throw new Error("percentage must be between 0 and 100.");
    }

    const isActive = active === undefined ? true : Boolean(active);

    const session = await mongoose.startSession();
    let commission;
    try {
      await session.withTransaction(async () => {
        if (isActive) {
          await Commission.updateMany({ active: true }, { $set: { active: false } }).session(session);
        }
        const [created] = await Commission.create([{ percentage: pct, active: isActive }], { session });
        commission = created;
      });
    } catch (e) {
      // If concurrent requests raced, partial unique index may reject the second "active: true" insert.
      if (isActive && e && (e.code === 11000 || e.code === 11001)) {
        const activeCommission = await Commission.findOne({ active: true }).sort({ updatedAt: -1 });
        if (activeCommission) {
          commission = activeCommission;
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    } finally {
      await session.endSession();
    }

    logger.info(`[EVENT] Commission updated: ${pct}% active=${isActive}`);
    await logAdminAction(req.admin?._id, "UPSERT_COMMISSION", commission._id, {
      percentage: pct,
      active: isActive,
    });
    return sendSuccess(res, 200, "Commission updated.", { commission });
  } catch (error) {
    return next(error);
  }
}

async function getCommission(_req, res, next) {
  try {
    const activeCommission = await Commission.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    return sendSuccess(res, 200, "Commission fetched.", { activeCommission });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  upsertCommission,
  getCommission
};
