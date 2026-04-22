const mongoose = require("mongoose");

const TRACTOR_TYPES = ["small", "medium", "large", "extra_large"];
const VERIFICATION_STATUS = ["pending", "approved", "rejected"];
const DOCUMENT_VERIFICATION_STATUS = ["pending", "approved", "rejected"];

const tractorSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tractorType: {
      type: String,
      enum: TRACTOR_TYPES,
      required: true,
    },
    brand: {
      type: String,
      required: true,
      trim: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    registrationNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    machineryTypes: {
      type: [String],
      default: [],
    },
    /** Optional normalized subtype names (per Service.types) for selected machinery service codes. */
    machinerySubTypes: {
      type: [String],
      default: [],
    },
    tractorPhoto: {
      type: String,
      trim: true,
      default: "",
    },
    rcDocument: {
      type: String,
      trim: true,
      default: "",
    },
    insuranceDocument: {
      type: String,
      trim: true,
      default: "",
    },
    pollutionDocument: {
      type: String,
      trim: true,
      default: "",
    },
    fitnessDocument: {
      type: String,
      trim: true,
      default: "",
    },
    rcVerificationStatus: {
      type: String,
      enum: DOCUMENT_VERIFICATION_STATUS,
      default: "pending",
    },
    rcVerificationReason: {
      type: String,
      trim: true,
      default: "",
    },
    insuranceVerificationStatus: {
      type: String,
      enum: DOCUMENT_VERIFICATION_STATUS,
      default: "pending",
    },
    insuranceVerificationReason: {
      type: String,
      trim: true,
      default: "",
    },
    pollutionVerificationStatus: {
      type: String,
      enum: DOCUMENT_VERIFICATION_STATUS,
      default: "pending",
    },
    pollutionVerificationReason: {
      type: String,
      trim: true,
      default: "",
    },
    fitnessVerificationStatus: {
      type: String,
      enum: DOCUMENT_VERIFICATION_STATUS,
      default: "pending",
    },
    fitnessVerificationReason: {
      type: String,
      trim: true,
      default: "",
    },
    insuranceExpiry: {
      type: Date,
      default: null,
    },
    pollutionExpiry: {
      type: Date,
      default: null,
    },
    fitnessExpiry: {
      type: Date,
      default: null,
    },
    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUS,
      default: "pending",
    },
    documentsVerified: {
      type: Boolean,
      default: false,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

tractorSchema.index({ operatorId: 1, verificationStatus: 1, isAvailable: 1 });
tractorSchema.index({ location: "2dsphere" });
tractorSchema.index({ isAvailable: 1 });
tractorSchema.index({ verificationStatus: 1, isAvailable: 1 });
// Admin pending queue (`listPendingTractors`)
tractorSchema.index({ verificationStatus: 1, isDeleted: 1, createdAt: -1 });

const Tractor = mongoose.model("Tractor", tractorSchema);

module.exports = Tractor;
module.exports.TRACTOR_TYPES = TRACTOR_TYPES;
module.exports.VERIFICATION_STATUS = VERIFICATION_STATUS;
module.exports.DOCUMENT_VERIFICATION_STATUS = DOCUMENT_VERIFICATION_STATUS;
