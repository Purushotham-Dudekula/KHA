const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");

function shouldIncludeDemandLocations(includeLocations) {
  return includeLocations === true || includeLocations === "true" || includeLocations === "1";
}

async function getAdminDashboard(req, res, next) {
  try {
    const COMPLETED_STATUSES = ["completed", "payment_pending", "closed"];
    const CANCELLED_STATUSES = ["cancelled", "rejected"];
    // "started" is mapped to "en_route" in this codebase lifecycle.
    const ACTIVE_STATUSES = ["accepted", "en_route", "in_progress"];

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

module.exports = {
  getAdminDashboard,
  getAdminRevenueAnalytics,
  getAdminDemandAnalytics,
};
