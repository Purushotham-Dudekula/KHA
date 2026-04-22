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

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function shouldIncludeDemandLocations(includeLocations) {
  return includeLocations === true || includeLocations === "true" || includeLocations === "1";
}

function adminPublic(adminDoc) {
  if (!adminDoc) return null;
  const o = adminDoc.toObject ? adminDoc.toObject() : { ...adminDoc };
  delete o.password;
  return {
    id: o._id,
    name: o.name,
    email: o.email,
    role: o.role,
    isActive: o.isActive,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function createAdmin(req, res, next) {
  try {
    const { name, email } = req.body || {};
    if (!name || !String(name).trim()) {
      return next(new AppError("name is required.", 400));
    }
    if (!email || !String(email).trim()) {
      return next(new AppError("email is required.", 400));
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await Admin.exists({ email: normalizedEmail });
    if (exists) {
      return next(new AppError("Email already registered.", 409));
    }

    const admin = await Admin.create({
      name: String(name).trim(),
      email: normalizedEmail,
      role: "admin",
      isActive: true,
    });

    logger.info(`[EVENT] Admin user created: ${admin._id.toString()}`);
    void logAuditAction(req.admin?._id, "ADMIN_APPROVAL_CREATE_ADMIN");
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "ADMIN_CREATED",
      targetId: admin._id,
      targetType: "admin",
      metadata: { role: admin.role, isActive: Boolean(admin.isActive) },
    });
    return sendSuccess(res, 201, "Admin created successfully", {
      admin: adminPublic(admin),
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(new AppError("Email already registered.", 409));
    }
    return next(error);
  }
}

async function bootstrapSuperAdmin(req, res, next) {
  try {
    const exists = await Admin.exists({});
    if (exists) {
      res.status(409);
      throw new Error("Super admin already initialized");
    }

    const { name, email } = req.body || {};
    if (!name || !String(name).trim()) {
      res.status(400);
      throw new Error("name is required.");
    }
    if (!email || !String(email).trim()) {
      res.status(400);
      throw new Error("email is required.");
    }

    const admin = await Admin.create({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      role: "super_admin",
      isActive: true,
    });

    logger.info(`[EVENT] Super admin bootstrapped: ${admin._id.toString()}`);
    void logAuditAction(admin._id, "ADMIN_APPROVAL_BOOTSTRAP_SUPER_ADMIN");
    return sendSuccess(res, 201, "Super admin created successfully", {
      admin: adminPublic(admin),
    });
  } catch (error) {
    if (error.code === 11000) {
      res.status(409);
      return next(new Error("Email already registered."));
    }
    return next(error);
  }
}

async function deactivateAdmin(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(new AppError("Valid admin id is required.", 400));
    }

    const target = await Admin.findById(id);
    if (!target) {
      return next(new AppError("Admin not found.", 404));
    }
    if (target.role === "super_admin") {
      return next(new AppError("Cannot manage super admin.", 403));
    }
    if (target.role !== "admin") {
      return next(new AppError("Only admin accounts can be managed.", 400));
    }
    if (target._id.equals(req.admin._id)) {
      return next(new AppError("Cannot deactivate yourself.", 400));
    }

    const hasExplicitActive = typeof req.body?.active === "boolean";
    target.isActive = hasExplicitActive ? req.body.active : !Boolean(target.isActive);
    await target.save();

    const event = target.isActive ? "activated" : "deactivated";
    logger.info(`[EVENT] Admin ${event}: ${target._id.toString()}`);
    void logAdminActivity({
      adminId: req.admin?._id,
      action: target.isActive ? "ADMIN_ACTIVATED" : "ADMIN_DEACTIVATED",
      targetId: target._id,
      targetType: "admin",
      metadata: { isActive: Boolean(target.isActive) },
    });
    return sendSuccess(res, 200, `Admin ${event}.`, {
      admin: adminPublic(target),
    });
  } catch (error) {
    return next(error);
  }
}

async function listAdmins(_req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(_req.query);
    const total = await Admin.countDocuments({ role: "admin" });
    const admins = await Admin.find({ role: "admin" })
      .select("name email role isActive createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return sendSuccess(res, 200, "Admins fetched.", {
      admins,
      data: admins,
      count: total,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listUsers(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select("-otp -otpExpiry").sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const mapped = users.map(cleanUserResponse);
    return sendSuccess(res, 200, "Users fetched.", {
      count: total,
      users: mapped,
      data: mapped,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listBookings(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("farmer", "name phone role")
        .populate("operator", "name phone role")
        .populate("tractor", "tractorType brand model registrationNumber"),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Bookings fetched.", {
      count: total,
      bookings,
      data: bookings,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function getLiveBookings(req, res, next) {
  try {
    const statuses = ["accepted", "confirmed", "en_route", "in_progress"];

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20), 50);
    const skip = (page - 1) * limit;

    const filter = { status: { $in: statuses } };

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("farmer", "name phone village location")
        .populate("operator", "name phone village location")
        .populate("tractor", "tractorType brand model registrationNumber tractorPhoto isAvailable verificationStatus")
        .lean(),
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));

    const statusToLive = (s) => {
      if (s === "accepted") return "ACCEPTED";
      if (s === "confirmed") return "ON_THE_WAY";
      if (s === "en_route") return "EN_ROUTE";
      if (s === "in_progress") return "STARTED";
      return s;
    };

    const data = bookings.map((b) => ({
      ...b,
      liveStatus: statusToLive(b.status),
      timestamps: {
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        respondedAt: b.respondedAt,
        startTime: b.startTime,
        endTime: b.endTime,
      },
      locations: {
        farmer: b.farmer?.location ?? null,
        operator: b.operator?.location ?? null,
      },
    }));

    return sendSuccess(res, 200, "Live bookings fetched.", {
      total,
      page,
      pages,
      data,
    });
  } catch (error) {
    return next(error);
  }
}

async function blockUser(req, res, next) {
  try {
    const { id } = req.params;
    const { isBlocked = true } = req.body || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid user id is required.");
    }
    const target = await User.findById(id).select("role");
    if (!target) {
      res.status(404);
      throw new Error("User not found.");
    }
    if (!["farmer", "operator"].includes(target.role)) {
      res.status(400);
      throw new Error("Only farmer or operator accounts can be blocked.");
    }

    const desired = Boolean(isBlocked);

    // Atomic + idempotent update:
    // - only writes if current state differs from desired
    // - prevents conflicting rapid admin actions from causing unnecessary toggles
    let user = await User.findOneAndUpdate(
      { _id: id, isBlocked: { $ne: desired } },
      { $set: { isBlocked: desired } },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");
    if (!user) {
      // Either user not found OR already in desired state. Fetch to disambiguate.
      user = await User.findById(id).select("-otp -otpExpiry");
      if (!user) {
        res.status(404);
        throw new Error("User not found.");
      }
    }
    logger.info(`[EVENT] Admin block user: ${user._id.toString()} isBlocked=${user.isBlocked}`);
    await invalidateUserAuthCache(user._id);
    await logAdminAction(req.admin?._id, user.isBlocked ? "BLOCK_USER" : "UNBLOCK_USER", user._id, {
      isBlocked: user.isBlocked,
    });
    return sendSuccess(res, 200, "User block status updated.", {
      user: cleanUserResponse(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function listComplaints(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    const [total, complaints] = await Promise.all([
      Complaint.countDocuments(filter),
      Complaint.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("bookingId", "status date time")
        .populate("userId", "name phone role")
        .populate("farmerId", "name phone")
        .populate("operatorId", "name phone"),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Complaints fetched.", {
      count: total,
      complaints,
      data: complaints,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function respondComplaint(req, res, next) {
  try {
    const { id } = req.params;
    const { adminResponse, status } = req.body || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid complaint id is required.");
    }
    if (!adminResponse || typeof adminResponse !== "string" || !adminResponse.trim()) {
      res.status(400);
      throw new Error("adminResponse is required.");
    }
    if (!["in_progress", "resolved"].includes(status)) {
      res.status(400);
      throw new Error('status must be "in_progress" or "resolved".');
    }
    const complaint = await Complaint.findByIdAndUpdate(
      id,
      { adminResponse: adminResponse.trim(), status },
      { new: true, runValidators: true }
    );
    if (!complaint) {
      res.status(404);
      throw new Error("Complaint not found.");
    }
    logger.info(`[EVENT] Admin respond complaint: ${complaint._id.toString()}`);
    return sendSuccess(res, 200, "Complaint updated.", { complaint });
  } catch (error) {
    return next(error);
  }
}

async function listAdminAuditLogs(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, logs] = await Promise.all([
      AdminAuditLog.countDocuments({}),
      AdminAuditLog.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("adminId", "name email role")
        .lean(),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Admin audit logs fetched.", {
      count: total,
      logs,
      data: logs,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function upsertPricing(req, res, next) {
  try {
    const { serviceType, pricePerAcre, pricePerHour } = req.body || {};

    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }
    const normalizedServiceType = serviceType.trim().toLowerCase();

    const pAcre = pricePerAcre === undefined || pricePerAcre === null ? null : Number(pricePerAcre);
    const pHour = pricePerHour === undefined || pricePerHour === null ? null : Number(pricePerHour);

    if (pAcre === null && pHour === null) {
      res.status(400);
      throw new Error("Provide pricePerAcre and/or pricePerHour.");
    }
    if (pAcre !== null && (!Number.isFinite(pAcre) || pAcre < 0)) {
      res.status(400);
      throw new Error("pricePerAcre must be a non-negative number.");
    }
    if (pHour !== null && (!Number.isFinite(pHour) || pHour < 0)) {
      res.status(400);
      throw new Error("pricePerHour must be a non-negative number.");
    }

    const existing = await Pricing.findOne({ serviceType: normalizedServiceType }).lean();

    const pricePerAcreFinal = pAcre !== null ? pAcre : Number(existing?.pricePerAcre || 0);
    const pricePerHourFinal = pHour !== null ? pHour : Number(existing?.pricePerHour || 0);

    const pricing = await Pricing.findOneAndUpdate(
      { serviceType: normalizedServiceType },
      {
        $set: {
          pricePerAcre: pricePerAcreFinal,
          pricePerHour: pricePerHourFinal,
        },
      },
      { new: true, upsert: true, runValidators: true }
    );

    await logAdminAction(req.admin?._id, "UPSERT_PRICING", pricing._id, {
      serviceType: normalizedServiceType,
      pricePerAcre: pricing.pricePerAcre,
      pricePerHour: pricing.pricePerHour,
    });

    return sendSuccess(res, 200, "Pricing updated.", { pricing });
  } catch (error) {
    return next(error);
  }
}

async function listPricing(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const total = await Pricing.countDocuments({});
    const pricing = await Pricing.find({}).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean();
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Pricing fetched.", { pricing, count: total, total, page, totalPages });
  } catch (error) {
    return next(error);
  }
}

async function upsertSeasonalPricing(req, res, next) {
  try {
    const { serviceType, startDate, endDate, multiplier } = req.body || {};

    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      res.status(400);
      throw new Error("startDate and endDate must be valid dates.");
    }
    if (end.getTime() <= start.getTime()) {
      res.status(400);
      throw new Error("endDate must be after startDate.");
    }
    const m = Number(multiplier);
    if (!Number.isFinite(m) || m <= 0) {
      res.status(400);
      throw new Error("multiplier must be greater than 0.");
    }

    const normalizedServiceType = serviceType.trim().toLowerCase();
    const overlap = await SeasonalPricing.exists({
      serviceType: normalizedServiceType,
      startDate: { $lte: end },
      endDate: { $gte: start },
    });
    if (overlap) {
      res.status(409);
      throw new Error("Seasonal pricing already exists for this period");
    }

    const doc = await SeasonalPricing.create({
      serviceType: normalizedServiceType,
      startDate: start,
      endDate: end,
      multiplier: m,
    });

    await logAdminAction(req.admin?._id, "CREATE_SEASONAL_PRICING", doc._id, {
      serviceType: doc.serviceType,
      startDate: doc.startDate,
      endDate: doc.endDate,
      multiplier: doc.multiplier,
    });

    return sendSuccess(res, 201, "Seasonal pricing created.", { seasonalPricing: doc });
  } catch (error) {
    return next(error);
  }
}

async function listSeasonalPricing(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const total = await SeasonalPricing.countDocuments({});
    const list = await SeasonalPricing.find({})
      .sort({ startDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Seasonal pricing fetched.", {
      seasonalPricing: list,
      count: total,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteSeasonalPricing(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid seasonal pricing id is required.");
    }
    const deleted = await SeasonalPricing.findByIdAndDelete(id).lean();
    if (!deleted) {
      res.status(404);
      throw new Error("Seasonal pricing not found.");
    }
    await logAdminAction(req.admin?._id, "DELETE_SEASONAL_PRICING", deleted._id, {
      serviceType: deleted.serviceType,
    });
    return sendSuccess(res, 200, "Seasonal pricing deleted.", { seasonalPricing: deleted });
  } catch (error) {
    return next(error);
  }
}

async function getAdminDashboard(req, res, next) {
  try {
    const COMPLETED_STATUSES = ["completed", "payment_pending", "closed"];
    const CANCELLED_STATUSES = ["cancelled", "rejected"];
    // "started" is mapped to "en_route" in this codebase lifecycle.
    const ACTIVE_STATUSES = ["accepted", "en_route", "in_progress"];

    const unrecognizedPayment = await Payment.findOne({
      type: { $nin: ["advance", "remaining", "full", "refund"] },
    }).lean();

    if (unrecognizedPayment) {
      throw new Error(`Unrecognized payment type found: ${unrecognizedPayment.type}`);
    }

    const [totalUsers, totalFarmers, totalOperators, totalBookings, bookingAgg, totalRevenueFromPaymentsAgg] =
      await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "farmer" }),
      User.countDocuments({ role: "operator" }),
      Booking.countDocuments({}),
      Booking.aggregate([
        {
          $match: {
            status: { $in: [...ACTIVE_STATUSES, ...COMPLETED_STATUSES, ...CANCELLED_STATUSES] },
          },
        },
        {
          $group: {
            _id: null,
            activeBookings: {
              $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] },
            },
            completedBookings: {
              $sum: { $cond: [{ $in: ["$status", COMPLETED_STATUSES] }, 1, 0] },
            },
            cancelledBookings: {
              $sum: { $cond: [{ $in: ["$status", CANCELLED_STATUSES] }, 1, 0] },
            },
            totalRevenue: {
              $sum: {
                $cond: [{ $in: ["$status", COMPLETED_STATUSES] }, "$platformFee", 0],
              },
            },
          },
        },
      ]),
      Payment.aggregate([{ $match: { status: "SUCCESS" } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
    ]);

    const summary = bookingAgg?.[0] || {};
    const activeBookings = summary.activeBookings || 0;
    const completedBookings = summary.completedBookings || 0;
    const cancelledBookings = summary.cancelledBookings || 0;
    const totalRevenue = summary.totalRevenue || 0;
    const totalRevenueFromPayments = totalRevenueFromPaymentsAgg?.[0]?.sum || 0;

    logger.info(
      `[EVENT] Admin dashboard fetched by admin=${req.admin?._id ? req.admin._id.toString() : "unknown"}`
    );
    return sendSuccess(res, 200, "Admin dashboard fetched.", {
      totalUsers,
      totalFarmers,
      totalOperators,
      totalBookings,
      activeBookings,
      completedBookings,
      cancelledBookings,
      totalRevenue,
      // Legacy field (prior dashboard implementation used Payment.amount success sums).
      totalRevenueFromPayments,
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminRevenueAnalytics(req, res, next) {
  try {
    const COMPLETED_STATUSES = ["completed", "payment_pending", "closed"];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Inclusive (start-of-day based) ranges.
    const last7Start = new Date(todayStart);
    last7Start.setDate(todayStart.getDate() - 6);

    const last30Start = new Date(todayStart);
    last30Start.setDate(todayStart.getDate() - 29);

    const unrecognizedPayment = await Payment.findOne({
      type: { $nin: ["advance", "remaining", "full", "refund"] },
    }).lean();

    if (unrecognizedPayment) {
      throw new Error(`Unrecognized payment type found: ${unrecognizedPayment.type}`);
    }

    const agg = await Booking.aggregate([
      { $match: { status: { $in: COMPLETED_STATUSES } } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$platformFee" },
          todayRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$endTime", todayStart] },
                    { $lte: ["$endTime", now] },
                  ],
                },
                "$platformFee",
                0,
              ],
            },
          },
          weeklyRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$endTime", last7Start] },
                    { $lte: ["$endTime", now] },
                  ],
                },
                "$platformFee",
                0,
              ],
            },
          },
          monthlyRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$endTime", last30Start] },
                    { $lte: ["$endTime", now] },
                  ],
                },
                "$platformFee",
                0,
              ],
            },
          },
        },
      },
    ]);

    const row = agg?.[0] || {};
    return sendSuccess(res, 200, "Revenue analytics fetched.", {
      todayRevenue: row.todayRevenue || 0,
      weeklyRevenue: row.weeklyRevenue || 0,
      monthlyRevenue: row.monthlyRevenue || 0,
      totalRevenue: row.totalRevenue || 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminDemandAnalytics(req, res, next) {
  try {
    const { startDate, endDate, includeLocations } = req.query || {};

    const match = {};

    // Use booking scheduled `date` field for demand windows.
    if (typeof startDate === "string" && startDate.trim()) {
      const s = new Date(startDate.trim());
      if (Number.isNaN(s.getTime())) {
        res.status(400);
        throw new Error("startDate must be a valid date.");
      }
      match.date = match.date || {};
      match.date.$gte = s;
    }
    if (typeof endDate === "string" && endDate.trim()) {
      const e = new Date(endDate.trim());
      if (Number.isNaN(e.getTime())) {
        res.status(400);
        throw new Error("endDate must be a valid date.");
      }
      match.date = match.date || {};
      match.date.$lte = e;
    }

    const wantLocations = shouldIncludeDemandLocations(includeLocations);

    const pipeline = [
      ...(Object.keys(match).length > 0 ? [{ $match: match }] : []),
      {
        $facet: {
          serviceDemand: [
            { $group: { _id: "$serviceType", count: { $sum: 1 } } },
            { $project: { _id: 0, serviceType: "$_id", count: 1 } },
            { $sort: { count: -1, serviceType: 1 } },
          ],
          monthlyDemand: [
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m", date: "$date" } },
                totalBookings: { $sum: 1 },
              },
            },
            { $project: { _id: 0, month: "$_id", totalBookings: 1 } },
            { $sort: { month: 1 } },
          ],
          peakHours: [
            { $match: { time: { $type: "string", $ne: "" } } },
            { $group: { _id: "$time", count: { $sum: 1 } } },
            { $project: { _id: 0, time: "$_id", count: 1 } },
            { $sort: { count: -1, time: 1 } },
            { $limit: 20 },
          ],
          ...(wantLocations
            ? {
                topLocations: [
                  {
                    $lookup: {
                      from: "users",
                      localField: "farmer",
                      foreignField: "_id",
                      as: "farmerDoc",
                    },
                  },
                  { $unwind: { path: "$farmerDoc", preserveNullAndEmptyArrays: true } },
                  {
                    $group: {
                      _id: "$farmerDoc.village",
                      count: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      village: { $ifNull: ["$_id", ""] },
                      count: 1,
                    },
                  },
                  { $match: { village: { $ne: "" } } },
                  { $sort: { count: -1, village: 1 } },
                  { $limit: 20 },
                ],
              }
            : {}),
        },
      },
    ];

    const agg = await Booking.aggregate(pipeline);
    const row = agg?.[0] || {};

    // Basic demand trends for dashboard.
    // totalBookings + topServiceTypes derive from `serviceDemand`.
    const totalBookings = Array.isArray(row.serviceDemand)
      ? row.serviceDemand.reduce((sum, r) => sum + (r?.count || 0), 0)
      : 0;
    const topServiceTypes = Array.isArray(row.serviceDemand) ? row.serviceDemand.slice(0, 5) : [];

    // bookingsByDate: last 7 days grouped by booking `date`.
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const bookingsByDateAgg = await Booking.aggregate([
      {
        $match: {
          date: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, date: "$_id", count: 1 } },
      { $sort: { date: 1 } },
    ]);

    const bookingsByDate = bookingsByDateAgg.map((r) => ({
      date: r.date,
      count: r.count,
    }));

    return sendSuccess(res, 200, "Demand analytics fetched.", {
      serviceDemand: row.serviceDemand || [],
      monthlyDemand: row.monthlyDemand || [],
      peakHours: row.peakHours || [],
      totalBookings,
      topServiceTypes,
      bookingsByDate,
      ...(wantLocations ? { topLocations: row.topLocations || [] } : {}),
    });
  } catch (error) {
    return next(error);
  }
}

async function broadcastNotification(req, res, next) {
  try {
    const { title, message, role, userIds } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400);
      throw new Error("title is required.");
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400);
      throw new Error("message is required.");
    }

    const t = title.trim();
    const m = message.trim();

    let sent = 0;

    // TODO: Move broadcast to queue system (Bull/Redis) for large-scale production.

    // Cursor-based iteration to avoid loading all users into memory.
    const query = {};
    if (typeof role === "string" && role.trim()) {
      query.role = role.trim().toLowerCase();
    }
    if (Array.isArray(userIds) && userIds.length > 0) {
      query._id = { $in: userIds };
    }

    const totalUsers = await User.countDocuments(query);
    const batchSize = 200; // keep within 100–200 range for stability
    logger.info(`[EVENT] Broadcast started: totalUsers=${totalUsers}, batchSize=${batchSize}`);

    const cursor = User.find(query, "_id").cursor();
    let batch = [];

    for await (const u of cursor) {
      batch.push(u._id);

      if (batch.length >= batchSize) {
        const batchDocs = await User.find({ _id: { $in: batch } })
          .select("_id fcmToken")
          .lean();
        const fcmById = new Map(batchDocs.map((u) => [String(u._id), u.fcmToken != null ? String(u.fcmToken) : ""]));
        await Promise.all(
          batch.map((userId) =>
            notifyUser({
              req,
              app: null,
              userId,
              message: m,
              type: "alert",
              title: t,
              fcmTokenPreloaded: fcmById.get(String(userId)) ?? "",
            })
          )
        );

        sent += batch.length;
        logger.info(
          `[EVENT] Broadcast batch processed: count=${batch.length}, progress=${sent}/${totalUsers}`
        );
        batch = [];
      }
    }

    // Process remaining batch (if any).
    if (batch.length > 0) {
      const batchDocs = await User.find({ _id: { $in: batch } })
        .select("_id fcmToken")
        .lean();
      const fcmById = new Map(batchDocs.map((u) => [String(u._id), u.fcmToken != null ? String(u.fcmToken) : ""]));
      await Promise.all(
        batch.map((userId) =>
          notifyUser({
            req,
            app: null,
            userId,
            message: m,
            type: "alert",
            title: t,
            fcmTokenPreloaded: fcmById.get(String(userId)) ?? "",
          })
        )
      );
      sent += batch.length;
      logger.info(
        `[EVENT] Broadcast batch processed: count=${batch.length}, progress=${sent}/${totalUsers}`
      );
    }

    logger.info(`[EVENT] Broadcast completed: totalSent=${sent}, totalUsers=${totalUsers}`);
    return sendSuccess(res, 200, "Broadcast notification sent.", {
      sent,
    });
  } catch (error) {
    return next(error);
  }
}

async function listAdminActivity(req, res, next) {
  try {
    const adminId = typeof req.query?.adminId === "string" ? req.query.adminId.trim() : "";
    const action = typeof req.query?.action === "string" ? req.query.action.trim() : "";
    const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20), 100);
    const skip = (page - 1) * limit;

    const filter = {};
    if (adminId) filter.adminId = adminId;
    if (action) filter.action = action;

    const [total, logs] = await Promise.all([
      AdminActivityLog.countDocuments(filter),
      AdminActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("adminId", "name email role")
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Admin activity fetched.", {
      count: total,
      logs,
      data: logs,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminMe(req, res, next) {
  try {
    const admin = req.admin;
    if (!admin) {
      res.status(401);
      throw new Error("Admin not found.");
    }

    return sendSuccess(res, 200, "Admin profile fetched.", {
      name: admin.name || null,
      email: admin.email || null,
      role: admin.role || null,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createAdmin,
  bootstrapSuperAdmin,
  deactivateAdmin,
  listAdmins,
  upsertPricing,
  listPricing,
  upsertSeasonalPricing,
  listSeasonalPricing,
  deleteSeasonalPricing,
  getAdminDashboard,
  getAdminRevenueAnalytics,
  getAdminDemandAnalytics,
  listUsers,
  listBookings,
  getLiveBookings,
  blockUser,
  listAdminAuditLogs,
  listComplaints,
  respondComplaint,
  broadcastNotification,
  getAdminMe,
  listAdminActivity,
  __testables: {
    parsePagination,
    adminPublic,
    shouldIncludeDemandLocations,
  }
};
