const mongoose = require("mongoose");

const COMPLAINT_STATUSES = ["open", "in_progress", "resolved"];
const COMPLAINT_CATEGORIES = ["Operator Issue", "Payment", "Machine", "Other", "General"];

const complaintSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: COMPLAINT_CATEGORIES,
      required: true,
      index: true,
    },
    images: {
      type: [String],
      default: [],
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      required: false,
      index: true,
    },
    farmerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      required: false,
      index: true,
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      required: false,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    status: {
      type: String,
      enum: COMPLAINT_STATUSES,
      default: "open",
      required: true,
    },
    adminResponse: {
      type: String,
      trim: true,
      default: "",
      maxlength: 3000,
    },
  },
  { timestamps: true }
);

complaintSchema.index({ status: 1, createdAt: -1 });
// Admin list (no filter) sorted by `createdAt`
complaintSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Complaint", complaintSchema);
module.exports.COMPLAINT_STATUSES = COMPLAINT_STATUSES;
module.exports.COMPLAINT_CATEGORIES = COMPLAINT_CATEGORIES;
