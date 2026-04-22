const Booking = require("../models/booking.model");
const { sendSuccess } = require("../utils/apiResponse");

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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

module.exports = {
  listBookings,
  getLiveBookings,
};
