const Payment = require("../models/payment.model");
const Booking = require("../models/booking.model");
const { sendSuccess } = require("../utils/apiResponse");

function parseMyPaymentsPagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function listMyPayments(req, res, next) {
  try {
    // Include:
    // - payments made by this user (farmer payer)
    // - payments related to bookings where this user is the operator (if applicable)
    const operatorBookingIds = await Booking.find({ operator: req.user._id })
      .select("_id")
      .lean();

    const ids = operatorBookingIds.map((b) => b._id);

    const filter =
      ids.length > 0
        ? { $or: [{ userId: req.user._id }, { bookingId: { $in: ids } }] }
        : { userId: req.user._id };

    const { page, limit, skip } = parseMyPaymentsPagination(req.query);

    const total = await Payment.countDocuments(filter);

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      // Optional booking basics for history UI
      .populate("bookingId", "serviceType date")
      .lean();

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return sendSuccess(res, 200, "Payments fetched.", {
      count: total,
      payments,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listMyPayments };
