const mongoose = require("mongoose");
const Tractor = require("./tractor.model");
const Booking = require("./booking.model");

const serviceTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 1,
      maxlength: 200,
    },
    pricePerHour: {
      type: Number,
      min: 0,
      default: 0,
    },
    pricePerAcre: {
      type: Number,
      min: 0,
      default: 0,
    },
    image: {
      type: String,
      trim: true,
      default: "",
    },
    imageEffective: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

const serviceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
      match: [/^[a-z0-9_]+$/, "Code must be lowercase with underscores (a-z, 0-9, _)."],
    },
    pricePerHour: {
      type: Number,
      min: 0,
      default: 0,
    },
    pricePerAcre: {
      type: Number,
      min: 0,
      default: 0,
    },
    image: {
      type: String,
      trim: true,
      default: "",
    },
    types: {
      type: [serviceTypeSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

serviceSchema.index({ isActive: 1, code: 1 });

serviceSchema.pre("validate", function () {
  const types = this.types;
  if (!Array.isArray(types) || types.length === 0) return;
  const seen = new Set();
  for (const t of types) {
    const n = String(t?.name || "").trim().toLowerCase();
    if (!n) continue;
    if (seen.has(n)) {
      throw new Error("Duplicate service type name");
    }
    seen.add(n);
  }
});

async function preventDeleteIfServiceInUse(next) {
  try {
    const filter = typeof this.getFilter === "function" ? this.getFilter() : {};
    const target = await this.model.findOne(filter).select("code").lean();
    if (!target || !target.code) return next();
    const code = String(target.code).trim().toLowerCase();

    const [tractorUsage, bookingUsage] = await Promise.all([
      Tractor.exists({ machineryTypes: { $in: [code] }, isDeleted: { $ne: true } }),
      Booking.exists({ serviceType: code }),
    ]);

    if (tractorUsage || bookingUsage) {
      return next(new Error("Service is in use and cannot be deleted"));
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

serviceSchema.pre("findOneAndDelete", preventDeleteIfServiceInUse);
serviceSchema.pre("findOneAndRemove", preventDeleteIfServiceInUse);
serviceSchema.pre("deleteOne", { document: false, query: true }, preventDeleteIfServiceInUse);

module.exports = mongoose.model("Service", serviceSchema);

