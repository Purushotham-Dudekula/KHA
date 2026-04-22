const mongoose = require("mongoose");

const seasonalPricingSchema = new mongoose.Schema(
  {
    serviceType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      required: true,
      index: true,
    },
    multiplier: {
      type: Number,
      required: true,
      min: 0.1,
    },
  },
  { timestamps: true }
);

seasonalPricingSchema.index({ serviceType: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model("SeasonalPricing", seasonalPricingSchema);

