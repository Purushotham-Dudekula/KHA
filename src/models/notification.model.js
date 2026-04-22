const mongoose = require("mongoose");

const NOTIFICATION_CATEGORIES = ["booking", "payment", "job", "alert"];

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_CATEGORIES,
      required: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

function strip(_doc, ret) {
  delete ret.__v;
  return ret;
}

notificationSchema.set("toJSON", { virtuals: true, transform: strip });
notificationSchema.set("toObject", { virtuals: true, transform: strip });

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = Notification;
module.exports.NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES;
