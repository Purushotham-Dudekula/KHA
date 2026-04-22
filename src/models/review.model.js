const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
    },
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    operator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    review: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

reviewSchema.index({ operator: 1, createdAt: -1 });
reviewSchema.index({ farmer: 1, createdAt: -1 });

function strip(_doc, ret) {
  delete ret.__v;
  return ret;
}

reviewSchema.set("toJSON", { virtuals: true, transform: strip });
reviewSchema.set("toObject", { virtuals: true, transform: strip });

module.exports = mongoose.model("Review", reviewSchema);
