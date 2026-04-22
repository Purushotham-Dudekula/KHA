/** OTP validity (farmer + admin login). */
const OTP_TTL_MS = 5 * 60 * 1000;

/** Max wrong OTP submissions before OTP is invalidated (per issued code). */
const MAX_OTP_VERIFY_ATTEMPTS = 5;

module.exports = { OTP_TTL_MS, MAX_OTP_VERIFY_ATTEMPTS };
