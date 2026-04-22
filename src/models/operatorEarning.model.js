const mongoose = require("mongoose");

const operatorEarningSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
    },
    totalAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    platformFee: {
      type: Number,
      min: 0,
      default: 0,
    },
    gstAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    operatorEarning: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

operatorEarningSchema.index({ operatorId: 1, createdAt: -1 });

module.exports = mongoose.model("OperatorEarning", operatorEarningSchema, "operator_earnings");
