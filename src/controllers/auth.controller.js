const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const ms = require("ms");
const User = require("../models/user.model");
const { cleanUserResponse } = require("../utils/cleanUserResponse");
const { sendSuccess } = require("../utils/apiResponse");
const { sendOTP } = require("../services/otp.service");
const { OTP_TTL_MS, MAX_OTP_VERIFY_ATTEMPTS } = require("../constants/otp");
const { generateSixDigitOtp } = require("../utils/otpCrypto");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { compareOtpToBcryptHash } = require("../utils/otpTimingSafeCompare");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");

function refreshTokenLifetimeMs() {
  const n = ms(env.jwtRefreshExpiresIn);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : ms("7d");
}

function generateAccessToken(userId) {
  return jwt.sign({ id: userId, tokenType: "access" }, process.env.JWT_SECRET, {
    expiresIn: env.jwtAccessExpiresIn,
  });
}

function generateRefreshToken(userId) {
  return jwt.sign({ id: String(userId), tokenType: "refresh" }, process.env.JWT_SECRET, {
    expiresIn: env.jwtRefreshExpiresIn,
  });
}

function parseCookie(header, name) {
  const raw = String(header || "");
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return "";
}

async function sendOtp(req, res, next) {
  try {
    const { phone } = req.body;

    if (!phone) {
      res.status(400);
      throw new Error("Phone is required.");
    }
    if (!/^\d{10}$/.test(String(phone).trim())) {
      res.status(400);
      throw new Error("Phone must be a valid 10-digit number.");
    }

    const otp = generateSixDigitOtp();
    const otpHash = await bcrypt.hash(String(otp), 10);
    const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

    await User.findOneAndUpdate(
      { phone },
      { $set: { otp: otpHash, otpExpiry, otpVerifyAttempts: 0 }, $setOnInsert: { phone } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendOTP(phone, otp);

    return sendSuccess(res, 200, "OTP sent successfully.", {});
  } catch (error) {
    return next(error);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      res.status(400);
      throw new Error("Phone and OTP are required.");
    }
    if (!/^\d{10}$/.test(String(phone).trim())) {
      res.status(400);
      throw new Error("Phone must be a valid 10-digit number.");
    }

    const user = await User.findOne({ phone }).select("+otp +otpExpiry +otpVerifyAttempts");

    if (!user) {
      res.status(404);
      throw new Error("User not found. Please request OTP first.");
    }

    if (!user.otp || !user.otpExpiry) {
      res.status(400);
      throw new Error("OTP not found. Please request a new OTP.");
    }

    if (user.otpExpiry.getTime() < Date.now()) {
      user.otp = null;
      user.otpExpiry = null;
      user.otpVerifyAttempts = 0;
      await user.save();
      res.status(400);
      throw new Error("OTP expired. Please request a new OTP.");
    }

    const inputOtp = String(otp).trim();
    const otpOk = await compareOtpToBcryptHash(inputOtp, user.otp);

    if (!otpOk) {
      const attempted = await User.findOneAndUpdate(
        { _id: user._id, otp: user.otp, otpExpiry: user.otpExpiry, otpVerifyAttempts: { $lt: MAX_OTP_VERIFY_ATTEMPTS } },
        { $inc: { otpVerifyAttempts: 1 } },
        { new: true }
      ).select("+otp +otpExpiry +otpVerifyAttempts");

      if (!attempted || (attempted.otpVerifyAttempts || 0) >= MAX_OTP_VERIFY_ATTEMPTS) {
        await User.updateOne(
          { _id: user._id },
          { $set: { otp: null, otpExpiry: null, otpVerifyAttempts: 0 } }
        );
        res.status(429);
        throw new Error("Too many invalid attempts. Request a new OTP.");
      }

      res.status(400);
      throw new Error("Invalid OTP.");
    }

    const isNewUser = user.isProfileComplete === false;

    const consumed = await User.findOneAndUpdate(
      {
        _id: user._id,
        otp: user.otp,
        otpVerifyAttempts: user.otpVerifyAttempts || 0,
        $and: [{ otpExpiry: user.otpExpiry }, { otpExpiry: { $gt: new Date() } }],
      },
      { $set: { otp: null, otpExpiry: null, otpVerifyAttempts: 0 } },
      { new: true }
    );
    if (!consumed) {
      logger.warn("[AUTH_ERROR] OTP consume failed (invalid or concurrent reuse)", {
        tag: "AUTH_ERROR",
        operation: "verifyOtp",
        userId: user?._id ? String(user._id) : null,
      });
      res.status(400);
      throw new Error("Invalid OTP.");
    }

    const token = generateAccessToken(user._id.toString());
    const refreshToken = generateRefreshToken(user._id.toString());
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    const refreshMs = refreshTokenLifetimeMs();
    const refreshTokenExpiresAt = new Date(Date.now() + refreshMs);
    await User.updateOne(
      { _id: user._id },
      { $set: { refreshTokenHash, refreshTokenExpiresAt } }
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: String(process.env.NODE_ENV || "").trim().toLowerCase() === "production",
      sameSite: "lax",
      maxAge: refreshMs,
      path: "/",
    });

    const fresh = await User.findById(user._id).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Login successful.", {
      token,
      user: cleanUserResponse(fresh, { viewerId: fresh._id }),
      isNewUser,
    });
  } catch (error) {
    return next(error);
  }
}

async function refreshToken(req, res, next) {
  try {
    const raw = parseCookie(req.headers.cookie, "refreshToken");
    if (!raw) {
      res.status(401);
      throw new Error("Refresh token missing.");
    }
    let decoded;
    try {
      decoded = jwt.verify(String(raw), process.env.JWT_SECRET);
    } catch {
      res.status(401);
      throw new Error("Refresh token invalid.");
    }
    const userId = decoded?.id ? String(decoded.id) : "";
    const tokenType = decoded?.tokenType != null ? String(decoded.tokenType) : "";
    if (tokenType && tokenType !== "refresh") {
      res.status(401);
      throw new Error("Refresh token invalid.");
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      res.status(401);
      throw new Error("Refresh token invalid.");
    }
    const user = await User.findById(userId).select("+refreshTokenHash +refreshTokenExpiresAt");
    if (!user || !user.refreshTokenHash || !user.refreshTokenExpiresAt) {
      res.status(401);
      throw new Error("Refresh token invalid.");
    }
    if (user.refreshTokenExpiresAt.getTime() < Date.now()) {
      await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
      res.status(401);
      throw new Error("Refresh token expired.");
    }
    const ok = await bcrypt.compare(String(raw), String(user.refreshTokenHash));
    if (!ok) {
      res.status(401);
      throw new Error("Refresh token invalid.");
    }
    // Rotate refresh token
    const newRefresh = generateRefreshToken(user._id.toString());
    const newHash = await bcrypt.hash(newRefresh, 10);
    const refreshMs = refreshTokenLifetimeMs();
    const newExp = new Date(Date.now() + refreshMs);
    await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: newHash, refreshTokenExpiresAt: newExp } });
    res.cookie("refreshToken", newRefresh, {
      httpOnly: true,
      secure: String(process.env.NODE_ENV || "").trim().toLowerCase() === "production",
      sameSite: "lax",
      maxAge: refreshMs,
      path: "/",
    });
    const token = generateAccessToken(user._id.toString());
    return sendSuccess(res, 200, "Token refreshed.", { token });
  } catch (error) {
    return next(error);
  }
}

async function logout(req, res, next) {
  try {
    if (!req.user || (!req.user.id && !req.user._id)) {
      res.status(401);
      throw new Error("Unauthorized");
    }

    const userId = String(req.user.id || req.user._id || "");
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      await User.updateOne(
        { _id: userId },
        { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } }
      );
    }
    res.clearCookie("refreshToken", { path: "/" });
    return sendSuccess(res, 200, "Logged out.", {});
  } catch (error) {
    return next(error);
  }
}

module.exports = { sendOtp, verifyOtp, refreshToken, logout };
