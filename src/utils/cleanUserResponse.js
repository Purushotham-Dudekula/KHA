/**
 * Returns a plain, role-sanitized user object safe for API responses.
 * Does not modify the database document.
 *
 * @param {import("mongoose").Document | Record<string, unknown> | null | undefined} user
 * @param {{ viewerId?: import("mongoose").Types.ObjectId | string | null }} [options]
 * @returns {Record<string, unknown> | null | undefined}
 */
function cleanUserResponse(user, options = {}) {
  if (user == null) {
    return user;
  }

  const data =
    typeof user.toObject === "function"
      ? user.toObject({ virtuals: false })
      : { ...user };

  delete data.otp;
  delete data.otpExpiry;
  delete data.otpVerifyAttempts;
  delete data.fcmToken;

  const role = data.role;
  const viewerId = options.viewerId != null ? String(options.viewerId) : null;
  const operatorSelf =
    role === "operator" && viewerId && data._id != null && String(data._id) === viewerId;

  if (role === "farmer") {
    delete data.tractorType;
    delete data.experience;
    delete data.education;
    delete data.aadhaarNumber;
    delete data.aadhaarDocument;
    delete data.drivingLicenseDocument;
    delete data.verificationStatus;
    delete data.aadhaarVerified;
    delete data.tractor;
    delete data.accountHolderName;
    delete data.accountNumber;
    delete data.ifsc;
    delete data.upiId;
  } else if (role === "operator") {
    delete data.landArea;
    delete data.primaryCrop;
    delete data.soilType;
    const approved =
      data.verificationStatus === "approved" ||
      (data.verificationStatus == null && data.aadhaarVerified === true);
    data.verified = approved === true;
    delete data.aadhaarVerified;
    delete data.verificationStatus;
    delete data.aadhaarNumber;
    delete data.aadhaarDocument;
    delete data.drivingLicenseDocument;
    if (!operatorSelf) {
      delete data.accountHolderName;
      delete data.accountNumber;
      delete data.ifsc;
      delete data.upiId;
    }
  }

  return data;
}

module.exports = { cleanUserResponse };
