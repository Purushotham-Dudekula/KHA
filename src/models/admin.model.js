const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format"],
    },
    password: {
      type: String,
      required: false,
      minlength: 6,
      select: false,
      default: null,
    },
    role: {
      type: String,
      enum: ["admin", "super_admin"],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
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
    otpVerifyAttempts: {
      type: Number,
      min: 0,
      default: 0,
      select: false,
    },
    otpVerified: {
      type: Boolean,
      default: false,
      select: false,
      index: true,
    },
    resetTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    resetTokenExpiry: {
      type: Date,
      default: null,
      select: false,
    },
  },
  { timestamps: true }
);

adminSchema.index({ role: 1 });

adminSchema.pre("save", async function enforceSingleSuperAdmin() {
  if (this.role !== "super_admin") {
    return;
  }
  const isNewSuper = this.isNew || this.isModified("role");
  if (!isNewSuper) {
    return;
  }
  const exists = await this.constructor.exists({
    role: "super_admin",
    _id: { $ne: this._id },
  });
  if (exists) {
    throw new Error("A super admin already exists.");
  }
});

module.exports = mongoose.model("Admin", adminSchema);
