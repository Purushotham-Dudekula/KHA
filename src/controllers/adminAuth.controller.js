const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Admin = require("../models/admin.model");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");
const { deliverAdminLoginOtp } = require("../services/adminEmail.service");
const { OTP_TTL_MS, MAX_OTP_VERIFY_ATTEMPTS } = require("../constants/otp");
const { AppError } = require("../utils/AppError");
const { generateSixDigitOtp } = require("../utils/otpCrypto");
const { compareOtpToBcryptHash } = require("../utils/otpTimingSafeCompare");
const { env } = require("../config/env");

const PASSWORD_AUTH_DISABLED_MESSAGE =
  "Password-based authentication is disabled. Use OTP login.";

function signAdminToken(admin) {
  return jwt.sign(
    {
      id: admin._id.toString(),
      scope: "admin",
      role: admin.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

async function adminLogin(req, res, next) {
  try {
    if (!env.enableEmails) {
      logger.warn("[EMAIL_ERROR] adminLogin blocked (emails disabled)", {
        tag: "EMAIL_ERROR",
        operation: "adminLogin",
      });
      return next(
        new AppError("Email delivery is disabled.", 503, {
          code: "EMAILS_DISABLED",
          userTip: "Contact an administrator.",
          retryable: false,
        })
      );
    }
    const { email } = req.body || {};

    if (!email || typeof email !== "string" || !email.trim()) {
      res.status(400);
      throw new Error("email is required.");
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const admin = await Admin.findOne({ email: normalizedEmail }).select(
      "+otp +otpExpiry +otpVerified +resetTokenHash +resetTokenExpiry +otpVerifyAttempts"
    );

    if (!admin) {
      return sendSuccess(res, 200, "If an account exists for this email, a login code was sent.", {});
    }
    if (!admin.isActive) {
      res.status(403);
      throw new Error("Admin account is deactivated.");
    }

    const otp = generateSixDigitOtp();
    const otpExpiry = new Date(Date.now() + OTP_TTL_MS);
    admin.otp = await bcrypt.hash(String(otp), 10);
    admin.otpExpiry = otpExpiry;
    admin.otpVerified = false;
    admin.otpVerifyAttempts = 0;
    admin.resetTokenHash = null;
    admin.resetTokenExpiry = null;
    await admin.save();

    await deliverAdminLoginOtp(admin.email, otp);

    logger.info(`[EVENT] Admin login OTP sent: ${admin._id.toString()}`);

    return sendSuccess(res, 200, "OTP sent to your email.", {});
  } catch (error) {
    return next(error);
  }
}

async function adminForgotPassword(req, res, next) {
  try {
    res.status(400);
    throw new Error(PASSWORD_AUTH_DISABLED_MESSAGE);
  } catch (error) {
    return next(error);
  }
}

async function adminVerifyOtp(req, res, next) {
  try {
    const { email, otp } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return next(new AppError("email is required.", 400));
    }
    if (otp === undefined || otp === null || String(otp).trim() === "") {
      return next(new AppError("otp is required.", 400));
    }

    const admin = await Admin.findOne({ email: String(email).trim().toLowerCase() }).select(
      "+otp +otpExpiry +otpVerified +resetTokenHash +resetTokenExpiry +otpVerifyAttempts"
    );
    if (!admin) {
      return next(new AppError("Admin not found.", 404));
    }
    if (!admin.isActive) {
      return next(new AppError("Admin account is disabled", 403));
    }
    if (!admin.otp || !admin.otpExpiry) {
      return next(new AppError("OTP not found. Please request a new code from login.", 400));
    }

    if (admin.otpExpiry.getTime() < Date.now()) {
      admin.otp = null;
      admin.otpExpiry = null;
      admin.otpVerifyAttempts = 0;
      await admin.save();
      return next(new AppError("OTP expired. Please request a new code from login.", 400));
    }

    const otpOk = await compareOtpToBcryptHash(otp, admin.otp);
    if (!otpOk) {
      const attempted = await Admin.findOneAndUpdate(
        {
          _id: admin._id,
          otp: admin.otp,
          otpExpiry: admin.otpExpiry,
          otpVerifyAttempts: { $lt: MAX_OTP_VERIFY_ATTEMPTS },
        },
        { $inc: { otpVerifyAttempts: 1 } },
        { new: true }
      ).select("+otp +otpExpiry +otpVerified +resetTokenHash +resetTokenExpiry +otpVerifyAttempts");

      if (!attempted || (attempted.otpVerifyAttempts || 0) >= MAX_OTP_VERIFY_ATTEMPTS) {
        await Admin.updateOne(
          { _id: admin._id },
          { $set: { otp: null, otpExpiry: null, otpVerifyAttempts: 0 } }
        );
        return next(new AppError("Too many invalid attempts. Request a new code from login.", 429));
      }
      return next(new AppError("Invalid OTP.", 400));
    }

    const consumed = await Admin.findOneAndUpdate(
      {
        _id: admin._id,
        otp: admin.otp,
        otpVerifyAttempts: admin.otpVerifyAttempts || 0,
        $and: [{ otpExpiry: admin.otpExpiry }, { otpExpiry: { $gt: new Date() } }],
      },
      {
        $set: {
          otpVerified: false,
          otp: null,
          otpExpiry: null,
          otpVerifyAttempts: 0,
          resetTokenHash: null,
          resetTokenExpiry: null,
        },
      },
      { new: true }
    );
    if (!consumed) {
      return next(new AppError("Invalid OTP.", 400));
    }

    const token = signAdminToken(admin);
    logger.info(`[EVENT] Admin OTP login: ${admin._id.toString()}`);

    return sendSuccess(res, 200, "Login successful", {
      token,
    });
  } catch (error) {
    return next(error);
  }
}

async function adminResetPassword(req, res, next) {
  try {
    res.status(400);
    throw new Error(PASSWORD_AUTH_DISABLED_MESSAGE);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  adminLogin,
  adminForgotPassword,
  adminVerifyOtp,
  adminResetPassword,
};
