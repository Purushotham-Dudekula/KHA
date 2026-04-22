const mongoose = require("mongoose");

const VERIFICATION_STATUS = ["pending", "approved", "rejected"];

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["farmer", "operator"],
      default: null,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    village: {
      type: String,
      trim: true,
      default: "",
    },
    mandal: {
      type: String,
      trim: true,
      default: "",
    },
    district: {
      type: String,
      trim: true,
      default: "",
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    pincode: {
      type: String,
      trim: true,
      default: "",
    },
    landArea: {
      type: Number,
      min: 0,
      default: 0,
    },
    primaryCrop: {
      type: String,
      trim: true,
      default: "",
    },
    soilType: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Operator-only field (production rule: cleared for farmers in controllers).
     * Note: per early versions, tractorType also existed on tractors; keep this field for role-based UI.
     */
    tractorType: {
      type: String,
      enum: ["small", "medium", "large", "extra_large"],
      default: null,
    },
    /**
     * Legacy single-tractor reference (controllers now support multiple tractors via Tractor model).
     * Kept for backward compatibility; cleared for farmers.
     */
    tractor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tractor",
      default: null,
    },
    experience: {
      type: String,
      enum: ["less_than_1", "1_3", "3_5", "5_10", "10_plus"],
      default: null,
    },
    education: {
      type: String,
      trim: true,
      default: "",
    },
    aadhaarNumber: {
      type: String,
      trim: true,
      default: "",
    },
    aadhaarDocument: {
      type: String,
      trim: true,
      default: "",
    },
    drivingLicenseDocument: {
      type: String,
      trim: true,
      default: "",
    },
    aadhaarVerified: {
      type: Boolean,
      default: false,
    },
    licenseVerified: {
      type: Boolean,
      default: false,
    },
    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUS,
      default: "pending",
    },
    isProfileComplete: {
      type: Boolean,
      default: false,
    },
    otp: {
      type: String,
      default: null,
      select: false,
    },
    otpExpiry: {
      type: Date,
      default: null,
      select: false,
    },
    /** Consecutive failed OTP verify attempts; reset when a new OTP is sent. */
    otpVerifyAttempts: {
      type: Number,
      min: 0,
      default: 0,
      select: false,
    },
    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      default: null,
      select: false,
      index: true,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    averageRating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    reviewCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    wallet: {
      type: Number,
      default: 0,
      min: 0,
    },
    language: {
      type: String,
      enum: ["en", "te", "hi"],
      default: "en",
    },
    /** Device FCM registration token; optional. Set via POST /api/user/fcm-token. */
    fcmToken: {
      type: String,
      trim: true,
      default: "",
      select: false,
    },
    /** Operator payout prep (PATCH /api/operator/bank-details). Not used for Razorpay yet. */
    accountHolderName: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumber: {
      type: String,
      trim: true,
      default: "",
    },
    ifsc: {
      type: String,
      trim: true,
      default: "",
    },
    upiId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ location: "2dsphere" });
userSchema.index({ role: 1, verificationStatus: 1 });
userSchema.index({ role: 1, phone: 1 });
// Admin user list (`listUsers`) — chronological pagination
userSchema.index({ createdAt: -1 });
userSchema.index({ isBlocked: 1, isOnline: 1, verificationStatus: 1 });

const User = mongoose.model("User", userSchema);

module.exports = User;
module.exports.VERIFICATION_STATUS = VERIFICATION_STATUS;
