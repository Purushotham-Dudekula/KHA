const mongoose = require("mongoose");
const User = require("../models/user.model");
const Tractor = require("../models/tractor.model");

/**
 * Operator must be approved and have at least one approved, available tractor.
 */
async function canOperatorServeBookings(operatorId) {
  const oid =
    operatorId instanceof mongoose.Types.ObjectId
      ? operatorId
      : new mongoose.Types.ObjectId(String(operatorId));

  const op = await User.findById(oid).select("verificationStatus role aadhaarVerified").lean();
  if (!op || op.role !== "operator") {
    return false;
  }
  const operatorApproved =
    op.verificationStatus === "approved" ||
    (op.verificationStatus == null && op.aadhaarVerified === true);
  if (!operatorApproved) {
    return false;
  }

  const hasNew = await Tractor.exists({
    operatorId: oid,
    verificationStatus: "approved",
    isAvailable: true,
    isDeleted: { $ne: true },
  });
  if (hasNew) return true;

  const legacy = await Tractor.collection.countDocuments({
    owner: oid,
    isVerified: true,
  });
  return legacy > 0;
}

module.exports = { canOperatorServeBookings };
