const mongoose = require("mongoose");

const TRANSACTION_STATUSES = ["pending", "success", "failed", "refunded", "partially_refunded"];

const transactionSchema = new mongoose.Schema(
  {
    ledgerKey: {
      type: String,
      trim: true,
      default: null,
      unique: true,
      sparse: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["payment", "refund"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: TRANSACTION_STATUSES,
      default: "pending",
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

transactionSchema.index({ bookingId: 1, type: 1 });
transactionSchema.index({ status: 1 });

module.exports = mongoose.model("LedgerTransaction", transactionSchema, "transactions");
module.exports.TRANSACTION_STATUSES = TRANSACTION_STATUSES;
