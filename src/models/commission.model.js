const mongoose = require("mongoose");

/**
 * Platform/commission settings applied to baseAmount.
 * Only one "active" commission is expected at a time (enforced by controller).
 */
const commissionSchema = new mongoose.Schema(
  {
    percentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Enforce: at most one active commission at a time.
commissionSchema.index(
  { active: 1 },
  {
    unique: true,
    name: "commission_single_active",
    partialFilterExpression: { active: true },
  }
);
// `Commission.findOne({ active: true }).sort({ updatedAt: -1 })` (booking + admin flows)
commissionSchema.index({ active: 1, updatedAt: -1 });

module.exports = mongoose.model("Commission", commissionSchema);

