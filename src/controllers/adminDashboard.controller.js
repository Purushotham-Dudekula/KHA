const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const User = require("../models/user.model");
const { sendSuccess } = require("../utils/apiResponse");
const { getOrSetCachedJson } = require("../services/cache.service");

const DASHBOARD_CACHE_TTL_SECONDS = 15;

async function getAdminDashboardBookingStats(_req, res, next) {
  try {
    const agg = await getOrSetCachedJson(
      "admin:dashboard:booking-stats:v1",
      DASHBOARD_CACHE_TTL_SECONDS,
      async () =>
        Booking.aggregate([
          {
            $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              pending: {
                $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
              },
              accepted: {
                $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] },
              },
              completed: {
                $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
              },
              cancelled: {
                $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
              },
            },
          },
        ])
    );

    const row = agg?.[0] || {};
    return sendSuccess(res, 200, "Booking stats fetched.", {
      totalBookings: row.totalBookings || 0,
      pending: row.pending || 0,
      accepted: row.accepted || 0,
      completed: row.completed || 0,
      cancelled: row.cancelled || 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminDashboardRevenueStats(_req, res, next) {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Revenue is computed from SUCCESS payments that represent completion of the charge.
    // Current system uses 2-step flow: remaining is the final money event.
    // Future-compatible: if a "full" payment type is introduced, it is included here without double counting.
    const unrecognizedPayment = await Payment.findOne({
      type: { $nin: ["advance", "remaining", "full", "refund"] },
    }).lean();

    if (unrecognizedPayment) {
      throw new Error(`Unrecognized payment type found: ${unrecognizedPayment.type}`);
    }

    const cacheKey = `admin:dashboard:revenue-stats:v1:${todayStart.toISOString()}:${monthStart.toISOString()}`;
    const agg = await getOrSetCachedJson(cacheKey, DASHBOARD_CACHE_TTL_SECONDS, async () =>
      Payment.aggregate([
        { $match: { status: "SUCCESS", type: { $in: ["remaining", "full"] } } },
        {
          $lookup: {
            from: "bookings",
            localField: "bookingId",
            foreignField: "_id",
            as: "booking",
          },
        },
        { $unwind: "$booking" },
        {
          // Ensure no double counting if both "remaining" and future "full" payments exist for same booking.
          $group: {
            _id: "$booking._id",
            platformFee: { $first: "$booking.platformFee" },
            revenueAt: { $max: "$createdAt" },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$platformFee" },
            todayRevenue: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: ["$revenueAt", todayStart] }, { $lte: ["$revenueAt", now] }] },
                  "$platformFee",
                  0,
                ],
              },
            },
            monthlyRevenue: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: ["$revenueAt", monthStart] }, { $lte: ["$revenueAt", now] }] },
                  "$platformFee",
                  0,
                ],
              },
            },
          },
        },
      ])
    );

    const row = agg?.[0] || {};
    return sendSuccess(res, 200, "Revenue stats fetched.", {
      totalRevenue: row.totalRevenue || 0,
      todayRevenue: row.todayRevenue || 0,
      monthlyRevenue: row.monthlyRevenue || 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminDashboardUserStats(_req, res, next) {
  try {
    const agg = await getOrSetCachedJson(
      "admin:dashboard:user-stats:v1",
      DASHBOARD_CACHE_TTL_SECONDS,
      async () =>
        User.aggregate([
          {
            $group: {
              _id: null,
              totalFarmers: {
                $sum: { $cond: [{ $eq: ["$role", "farmer"] }, 1, 0] },
              },
              totalOperators: {
                $sum: { $cond: [{ $eq: ["$role", "operator"] }, 1, 0] },
              },
            },
          },
        ])
    );

    const row = agg?.[0] || {};
    return sendSuccess(res, 200, "User stats fetched.", {
      totalFarmers: row.totalFarmers || 0,
      totalOperators: row.totalOperators || 0,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAdminDashboardBookingStats,
  getAdminDashboardRevenueStats,
  getAdminDashboardUserStats,
};
