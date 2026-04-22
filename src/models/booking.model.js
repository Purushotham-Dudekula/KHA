const mongoose = require("mongoose");

/**
 * KH Agriconnect — Booking schema
 *
 * Parties
 * - farmer / operator: refs to User; define who requested the service and who will perform it.
 *
 * status (lifecycle)
 * - pending: created; awaiting operator response.
 * - accepted: operator accepted; farmer may pay advance next.
 * - rejected: operator declined the request (still pending was the prior state).
 * - confirmed: booking is firm (e.g. advance received or explicit confirmation).
 * - en_route: operator is travelling to the site (optional GPS / manual step).
 * - in_progress: work has started (startTime set).
 * - completed: field work finished (endTime set); balance may still be due.
 * - payment_pending: settlement in progress (optional explicit state before closed).
 * - closed: terminal — booking fully settled and archived for reporting.
 * - cancelled: terminal — stopped by farmer, operator, or system.
 *
 * paymentStatus (money)
 * - no_payment: nothing invoiced / due yet (e.g. brand-new request).
 * - advance_due: operator accepted (or policy triggers); farmer should pay advance.
 * - advance_paid: advance received; job may start per your API rules.
 * - balance_due: work completed (or policy); remaining amount is due.
 * - fully_paid: legacy — all money collected (closed booking).
 * - paid: all money collected; pair with status closed (platform-held / escrow semantics; no auto-payout).
 *
 * Pricing fields
 * - baseAmount: pre-tax service subtotal.
 * - gstAmount: tax component (0 if not applicable).
 * - platformFee: KH Agriconnect fee slice.
 * - totalAmount: baseAmount + gstAmount + platformFee (what the customer sees as total).
 * - operatorEarning: operator share after full payment settlement (totalAmount − platformFee − GST slice).
 * - advanceAmount / remainingAmount: instalments derived from business rules (e.g. 20% advance).
 *
 * Cancellation / refunds
 * - cancelledBy: who initiated cancellation (audit).
 * - cancellationReason: free text for support and disputes.
 * - refundStatus: none / pending / approved / rejected / partial_failed / completed (legacy).
 */
const BOOKING_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "payment_pending",
  "closed",
  "cancelled",
];

const PAYMENT_STATUSES = [
  "no_payment",
  "advance_due",
  "advance_paid",
  "balance_due",
  "fully_paid",
  "paid",
];

const CANCELLED_BY = ["farmer", "operator", "system"];

/** At most one booking per farmer while in any of these statuses (partial unique index). */
const FARMER_ACTIVE_BOOKING_STATUSES = [
  "pending",
  "accepted",
  "confirmed",
  "en_route",
  "in_progress",
];

// Refund is manual-admin controlled in this backend.
// Keep "completed" as a legacy alias to avoid breaking existing data.
const REFUND_STATUSES = ["none", "pending", "approved", "rejected", "partial_failed", "completed"];

const bookingSchema = new mongoose.Schema(
  {
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
    tractor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tractor",
      required: true,
    },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: "pending",
    },
    landArea: {
      type: Number,
      min: 0,
      default: 0,
    },
    serviceType: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    baseAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    gstAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    platformFee: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Set when remaining balance is paid and settlement runs (post–full-payment split). */
    operatorEarning: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    // Offer discount applied during booking creation (stored as percentage).
    discountApplied: {
      type: Number,
      min: 0,
      default: 0,
    },
    discountAmount: {
      // Actual amount deducted from `totalAmount` when an offer is applied.
      type: Number,
      min: 0,
      default: 0,
    },
    seasonalMultiplier: {
      type: Number,
      min: 0.1,
      default: 1,
    },
    seasonalPricingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SeasonalPricing",
      default: null,
    },
    estimatedAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    finalAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    priceDifferenceReason: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Production naming for transparency in API responses.
     */
    advanceAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    remainingAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "no_payment",
    },
    date: {
      type: Date,
      required: true,
    },
    time: {
      type: String,
      trim: true,
      default: "",
    },
    startTime: {
      type: Date,
      default: null,
    },
    endTime: {
      type: Date,
      default: null,
    },

    // Operator job progress (only updated via PATCH /api/bookings/:id/progress).
    progress: {
      type: Number,
      enum: [0, 25, 50, 75, 100],
      default: 0,
    },
    progressImages: {
      type: [String],
      default: [],
      validate: {
        validator: function (v) {
          return Array.isArray(v) && v.length <= 5;
        },
        message: "progressImages cannot exceed 5 items.",
      },
    },

    // Generated on-demand and stored for fast downloads.
    invoiceUrl: {
      type: String,
      trim: true,
      default: "",
    },
    cancelledBy: {
      type: String,
      enum: CANCELLED_BY,
    },
    cancellationReason: {
      type: String,
      trim: true,
      default: "",
    },
    refundReason: {
      type: String,
      trim: true,
      default: "",
    },
    refundStatus: {
      type: String,
      enum: REFUND_STATUSES,
      default: "none",
    },
    penaltyApplied: {
      type: Boolean,
      default: false,
    },
    /** Snapshot of eligible refund (INR) at cancellation; admin still approves payout. */
    refundAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Cancellation / penalty charge (INR) aligned with refund policy snapshot. */
    cancellationCharge: {
      type: Number,
      min: 0,
      default: 0,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    jobReminderSent: {
      type: Boolean,
      default: false,
    },
    /** When operator accepted or rejected (for response-time metrics). */
    respondedAt: {
      type: Date,
      default: null,
    },
    /** Set when operator accepts; used for advance-payment deadline (30 min from acceptance). */
    acceptedAt: {
      type: Date,
      default: null,
    },
    /**
     * Soft lock expiry for payment confirmation window.
     * Set when booking enters `payment_pending`.
     */
    lockExpiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// List + filter patterns (farmer/operator booking history, admin lists).
bookingSchema.index({ farmer: 1, status: 1, createdAt: -1 });
bookingSchema.index({ farmer: 1, createdAt: -1 });
bookingSchema.index({ operator: 1, status: 1, createdAt: -1 });
bookingSchema.index({ operator: 1, createdAt: -1 });
bookingSchema.index({ paymentStatus: 1, date: 1, serviceType: 1 });
bookingSchema.index(
  { farmer: 1 },
  {
    unique: true,
    name: "farmer_one_active_booking",
    partialFilterExpression: {
      status: { $in: FARMER_ACTIVE_BOOKING_STATUSES },
    },
  }
);
// NOTE: Operator-based unique slot index removed (conflicted with tractor-based scheduling).
// Machine slot uniqueness (production requirement):
// - machineId maps to `tractor`
// - slot maps to `time`
// This prevents two active bookings from reserving the same machine at the same date+slot.
bookingSchema.index(
  { tractor: 1, date: 1, time: 1 },
  {
    unique: true,
    name: "machine_slot_unique_active",
    partialFilterExpression: {
      status: { $in: ["pending", "accepted", "confirmed", "en_route", "in_progress"] },
    },
  }
);
bookingSchema.index({ status: 1, createdAt: -1 });
// payment_pending lock expiry cron (`bookingPaymentLock.cron.js`)
bookingSchema.index({ status: 1, lockExpiresAt: 1 });
// Stuck monitoring: `paymentReconciliation.cron.js` (status + updatedAt)
bookingSchema.index({ status: 1, updatedAt: 1 });
// Admin “all bookings” and time-ordered scans
bookingSchema.index({ createdAt: -1 });

/** Mutates plain object or serialized booking: handles duplicate advance instalment fields for API output backward compatibility. */
function applyAdvanceFieldDedupe(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.advancePayment !== undefined) {
    if (obj.advanceAmount === undefined || obj.advanceAmount === null) {
      obj.advanceAmount = Number(obj.advancePayment);
    }
    delete obj.advancePayment;
  }
  return obj;
}

function stripBookingInternals(_doc, ret) {
  delete ret.__v;
  applyAdvanceFieldDedupe(ret);
  return ret;
}

bookingSchema.set("toJSON", {
  virtuals: true,
  transform: stripBookingInternals,
});
bookingSchema.set("toObject", {
  virtuals: true,
  transform: stripBookingInternals,
});

const Booking = mongoose.model("Booking", bookingSchema);

module.exports = Booking;
module.exports.applyAdvanceFieldDedupe = applyAdvanceFieldDedupe;
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.FARMER_ACTIVE_BOOKING_STATUSES = FARMER_ACTIVE_BOOKING_STATUSES;
