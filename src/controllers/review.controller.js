const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const Review = require("../models/review.model");
const { syncOperatorRatingFromReviews } = require("../services/operatorStats.service");
const { AppError } = require("../utils/AppError");
const { sendSuccess } = require("../utils/apiResponse");

async function submitReview(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      throw new AppError("Only farmers can submit reviews.", 403);
    }

    const { id } = req.params;
    const { rating, review } = req.body;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Valid booking id is required.", 400);
    }

    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      throw new AppError("rating must be an integer from 1 to 5.", 400);
    }

    const text =
      review != null && typeof review === "string" ? review.trim().slice(0, 2000) : "";

    const booking = await Booking.findById(id);
    if (!booking) {
      throw new AppError("Booking not found.", 404);
    }

    if (!booking.farmer.equals(req.user._id)) {
      throw new AppError("You can only review your own bookings.", 403);
    }

    if (!["completed", "closed"].includes(booking.status)) {
      throw new AppError(
        "You can only review after the job is completed (status completed or closed).",
        400,
        {
          code: "REVIEW_NOT_ALLOWED",
          userTip: "Complete the job and payment flow first.",
          retryable: false,
        }
      );
    }

    try {
      const doc = await Review.create({
        bookingId: booking._id,
        farmer: booking.farmer,
        operator: booking.operator,
        rating: r,
        review: text,
      });

      await syncOperatorRatingFromReviews(booking.operator);

      return sendSuccess(res, 201, "Thank you for your feedback.", {
        review: doc,
      });
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError("You have already reviewed this booking.", 409, {
          code: "DUPLICATE_REVIEW",
          userTip: "Each booking allows one review.",
          retryable: false,
        });
      }
      throw err;
    }
  } catch (error) {
    return next(error);
  }
}

module.exports = { submitReview };
