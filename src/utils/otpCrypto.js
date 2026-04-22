const crypto = require("crypto");

/** Uniform 6-digit numeric OTP (100000–999999), cryptographically secure. */
function generateSixDigitOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

module.exports = { generateSixDigitOtp };
