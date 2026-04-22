const mongoose = require("mongoose");

/**
 * Dynamic pricing per serviceType.
 * - pricePerAcre: used for land-area based services
 * - pricePerHour: fallback for time-based services (requires hours in requests)
 */
const pricingSchema = new mongoose.Schema(
  {
    serviceType: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    pricePerAcre: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    pricePerHour: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Pricing", pricingSchema);

