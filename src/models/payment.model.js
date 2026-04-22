const mongoose = require("mongoose");

const PAYMENT_TYPES = ["advance", "remaining", "full", "refund"];
const PAYMENT_STATUSES = ["PENDING", "SUCCESS", "FAILED", "REFUNDED"];
const PAYMENT_METHODS = ["cash", "upi"];
// Admin-controlled refund workflow; "processed" = UPI refund completed via Razorpay.
const PAYMENT_REFUND_STATUSES = ["none", "pending", "approved", "rejected", "processed"];

const paymentSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    type: {
      type: String,
      enum: {
        values: PAYMENT_TYPES,
        message: "{VALUE} is not a valid payment type!",
      },
      required: true,
    },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "PENDING",
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHODS,
      required: true,
    },
    transactionId: {
      type: String,
      trim: true,
      default: "",
    },
    // Razorpay (optional, stored for future integration)
    orderId: {
      type: String,
      trim: true,
      default: "",
    },
    paymentId: {
      type: String,
      trim: true,
      default: "",
    },
    refundId: {
      type: String,
      trim: true,
      default: "",
    },

    // Refund metadata (manual-only in this backend).
    refundStatus: {
      type: String,
      enum: PAYMENT_REFUND_STATUSES,
      default: "none",
    },
    refundReason: {
      type: String,
      trim: true,
      default: "",
    },
    refundedAt: {
      type: Date,
      default: null,
    },
    walletDebitedAt: {
      type: Date,
      default: null,
    },
    walletRefundCreditedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ bookingId: 1, type: 1, createdAt: -1 });
paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ status: 1, type: 1, createdAt: -1 });
// Reconcile queue + stuck-PENDING monitoring (`payment.queue.js`, `paymentReconciliation.cron.js`)
paymentSchema.index({ status: 1, createdAt: 1 });
paymentSchema.index({ refundStatus: 1 });
paymentSchema.index({ status: 1, refundStatus: 1 });
// `GET` payment history (`payment.controller.js`)
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ bookingId: 1, type: 1 }, { unique: true });
paymentSchema.index(
  { paymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentId: { $type: "string", $nin: ["", null] } },
  }
);

module.exports = mongoose.model("Payment", paymentSchema);
module.exports.PAYMENT_TYPES = PAYMENT_TYPES;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.PAYMENT_REFUND_STATUSES = PAYMENT_REFUND_STATUSES;
