const express = require("express");
const { sendOtp, verifyOtp, refreshToken, logout } = require("../controllers/auth.controller");
const { validate } = require("../middleware/validate.middleware");
const { buildLimiter } = require("../middleware/rateLimit.middleware");
const { protect } = require("../middleware/auth.middleware");
const authValidation = require("../validations/auth.validation");

const router = express.Router();
const isTestEnv = String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";

const authLoginLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  maxAuthenticated: isTestEnv ? 100000 : 5,
  maxUnauthenticated: isTestEnv ? 100000 : 5,
  message: "Too many attempts from this IP. Please try again later.",
});

const otpFlowLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  maxAuthenticated: isTestEnv ? 100000 : 5,
  maxUnauthenticated: isTestEnv ? 100000 : 5,
  message: "Too many attempts from this IP. Please try again later.",
});

const sendOtpLimiter = buildLimiter({
  windowMs: 60 * 1000,
  maxAuthenticated: 5,
  maxUnauthenticated: 5,
  message: "Too many OTP requests from this IP. Please try again after a few minutes.",
});

const verifyOtpLimiter = buildLimiter({
  windowMs: 60 * 1000,
  maxAuthenticated: 5,
  maxUnauthenticated: 5,
  message: "Too many verification attempts from this IP. Please try again later.",
});

router.post("/send-otp", authLoginLimiter, otpFlowLimiter, sendOtpLimiter, validate(authValidation.sendOtp), sendOtp);
router.post("/verify-otp", otpFlowLimiter, verifyOtpLimiter, validate(authValidation.verifyOtp), verifyOtp);
// Canonical refresh endpoint.
router.post("/refresh", verifyOtpLimiter, validate(authValidation.refreshToken), refreshToken);
// Backward-compatible alias.
router.post("/refresh-token", verifyOtpLimiter, validate(authValidation.refreshToken), refreshToken);
router.post("/logout", protect, logout);

module.exports = router;
