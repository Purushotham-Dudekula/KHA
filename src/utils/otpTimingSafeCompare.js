const bcrypt = require("bcryptjs");

/**
 * Compare a plaintext OTP to a stored bcrypt hash using bcrypt's constant-time path.
 * Avoids string equality (===) on secrets.
 */
async function compareOtpToBcryptHash(plainOtp, bcryptHash) {
  const plain = String(plainOtp ?? "").trim();
  const hash = String(bcryptHash ?? "");
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

module.exports = { compareOtpToBcryptHash };
