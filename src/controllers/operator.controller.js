const Payment = require("../models/payment.model");
const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const OperatorEarning = require("../models/operatorEarning.model");
const { sendSuccess } = require("../utils/apiResponse");

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const MAX_EARNINGS_CLOSED_BOOKINGS = 100;

function parseClosedBookingsLimit(query) {
  const raw = parseInt(query?.limit, 10);
  const n = Number.isFinite(raw) ? raw : 100;
  return Math.min(MAX_EARNINGS_CLOSED_BOOKINGS, Math.max(1, n));
}

function parseOptionalISODate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Per-booking operator share: settled `operatorEarning` when set (including 0), else legacy `baseAmount`. */
function operatorShareFromBooking(booking) {
  const oe = booking.operatorEarning;
  const share =
    oe !== undefined && oe !== null ? Number(oe) : Number(booking.baseAmount);
  return round2(Math.max(0, Number.isFinite(share) ? share : 0));
}

async function updateOperatorBankDetails(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update bank details.");
    }

    const { accountHolderName, accountNumber, ifsc, upiId } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          accountHolderName:
            accountHolderName != null && String(accountHolderName).trim()
              ? String(accountHolderName).trim()
              : "",
          accountNumber: String(accountNumber).replace(/\s/g, ""),
          ifsc: String(ifsc).replace(/\s/g, "").toUpperCase(),
          upiId: upiId != null && String(upiId).trim() ? String(upiId).trim() : "",
        },
      },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    if (!user) {
      res.status(404);
      throw new Error("User not found.");
    }

    return sendSuccess(res, 200, "Bank details saved.", {
      bankDetails: {
        accountHolderName: user.accountHolderName || "",
        accountNumber: user.accountNumber || "",
        ifsc: user.ifsc || "",
        upiId: user.upiId || "",
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getOperatorEarnings(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can view earnings.");
    }

    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(dayStart);
    weekStart.setDate(dayStart.getDate() - dayStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const last12MonthsStart = new Date(now);
    last12MonthsStart.setMonth(last12MonthsStart.getMonth() - 11);

    const totalJobs = await Booking.countDocuments({
      operator: req.user._id,
      status: { $in: ["completed", "closed"] },
    });

    const bookingLimit = parseClosedBookingsLimit(req.query);
    const fromDate = parseOptionalISODate(req.query.from);
    const toDate = parseOptionalISODate(req.query.to);

    const closedFilter = { operator: req.user._id, status: "closed" };
    if (fromDate || toDate) {
      closedFilter.createdAt = {};
      if (fromDate) closedFilter.createdAt.$gte = fromDate;
      if (toDate) closedFilter.createdAt.$lte = toDate;
    }

    const closedBookings = await Booking.find(closedFilter)
      .select("operatorEarning baseAmount updatedAt")
      .sort({ updatedAt: -1 })
      .limit(bookingLimit)
      .lean();

    const bookingIds = closedBookings.map((b) => b._id);

    const remByBookingId = new Map();
    if (bookingIds.length > 0) {
      const remPayments = await Payment.find({
        bookingId: { $in: bookingIds },
        type: "remaining",
        status: "SUCCESS",
      })
        .select("bookingId createdAt")
        .lean();
      for (const p of remPayments) {
        remByBookingId.set(String(p.bookingId), p.createdAt);
      }
    }

    const earnedAt = (b) => {
      const remAt = remByBookingId.get(String(b._id));
      return remAt ? new Date(remAt) : new Date(b.updatedAt);
    };

    const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    let totalEarnings = 0;
    let dailyEarnings = 0;
    let weeklyEarnings = 0;
    let monthlyEarnings = 0;
    const monthBucket = new Map();

    for (const b of closedBookings) {
      const share = operatorShareFromBooking(b);
      totalEarnings += share;
      const d = earnedAt(b);
      if (d >= dayStart) dailyEarnings += share;
      if (d >= weekStart) weeklyEarnings += share;
      if (d >= monthStart) monthlyEarnings += share;
      if (d >= last12MonthsStart) {
        const y = d.getFullYear();
        const m = d.getMonth();
        const key = `${y}-${m}`;
        const existing = monthBucket.get(key);
        if (existing) {
          existing.totalAmount += share;
        } else {
          monthBucket.set(key, {
            monthLabel: MONTH_LABELS[m],
            year: y,
            monthNumber: m + 1,
            totalAmount: share,
          });
        }
      }
    }

    totalEarnings = round2(totalEarnings);
    dailyEarnings = round2(dailyEarnings);
    weeklyEarnings = round2(weeklyEarnings);
    monthlyEarnings = round2(monthlyEarnings);

    const monthlyRows = Array.from(monthBucket.values()).sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.monthNumber - b.monthNumber;
    });
    const monthly = monthlyRows.map((row) => ({
      month: row.monthLabel,
      totalAmount: round2(row.totalAmount),
    }));

    return sendSuccess(res, 200, "Operator earnings fetched.", {
      todayEarnings: dailyEarnings,
      weeklyEarnings,
      monthlyEarnings,
      monthly,
      totalEarnings,
      totalJobs,
      note: "Showing earnings for recent records. Use date filters for full history.",
    });
  } catch (error) {
    return next(error);
  }
}

async function updateOperatorLocation(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update location.");
    }

    const { latitude, longitude } = req.body || {};

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      res.status(400);
      throw new Error("latitude must be a valid number between -90 and 90.");
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      res.status(400);
      throw new Error("longitude must be a valid number between -180 and 180.");
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        location: { type: "Point", coordinates: [lng, lat] },
        isOnline: true,
      },
      { new: true, runValidators: true }
    ).select("location isOnline");

    if (!user) {
      res.status(404);
      throw new Error("Operator not found.");
    }

    return sendSuccess(res, 200, "Operator location updated.", {
      location: { latitude: lat, longitude: lng },
    });
  } catch (error) {
    return next(error);
  }
}

async function getOperatorEarningsHistory(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can view earnings history.");
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;

    const earningsHistory = await OperatorEarning.find({ operatorId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return sendSuccess(res, 200, "Earnings history fetched.", {
      earningsHistory,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getOperatorEarnings,
  getOperatorEarningsHistory,
  updateOperatorLocation,
  updateOperatorBankDetails,
};
