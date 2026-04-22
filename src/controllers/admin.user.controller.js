const mongoose = require("mongoose");
const User = require("../models/user.model");
const { logAdminAction } = require("../services/adminAuditLog.service");
const { cleanUserResponse } = require("../utils/cleanUserResponse");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");
const { invalidateUserAuthCache } = require("../middleware/auth.middleware");

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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

module.exports = {
  listUsers,
  blockUser,
};
