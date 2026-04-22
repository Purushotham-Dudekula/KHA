const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { getRedisClient } = require("../services/redis.service");

const USER_CACHE_TTL_SECONDS = 60;

function buildUserCacheKey(userId) {
  return `auth:user:${String(userId)}`;
}

async function getUserFromRedis(userId) {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(buildUserCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function setUserToRedis(user) {
  const redis = getRedisClient();
  if (!redis || !user?._id) return;
  try {
    const serialized =
      user && typeof user.toObject === "function"
        ? user.toObject({ getters: false, virtuals: false })
        : user;
    await redis.set(
      buildUserCacheKey(user._id),
      JSON.stringify(serialized),
      "EX",
      USER_CACHE_TTL_SECONDS
    );
  } catch {
    // Best-effort cache write.
  }
}

async function invalidateUserAuthCache(userId) {
  const redis = getRedisClient();
  if (!redis || !userId) return;
  try {
    await redis.del(buildUserCacheKey(userId));
  } catch {
    // Best-effort cache eviction.
  }
}

async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      res.status(401);
      throw new Error("Unauthorized. Token missing.");
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.tokenType === "refresh") {
      res.status(401);
      throw new Error("Unauthorized. Invalid or expired token.");
    }

    if (decoded.scope === "admin") {
      res.status(401);
      throw new Error("Use admin login for admin routes.");
    }

    let user = await getUserFromRedis(decoded.id);
    if (!user) {
      user = await User.findById(decoded.id).select("-otp -otpExpiry");
      if (user) {
        await setUserToRedis(user);
      }
    }
    if (!user) {
      res.status(401);
      throw new Error("Unauthorized. User not found.");
    }
    if (user.isBlocked === true) {
      res.status(403);
      throw new Error("User is blocked");
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      res.status(401);
      return next(new Error("Unauthorized. Invalid or expired token."));
    }

    return next(error);
  }
}

/**
 * Requires one of the given user roles on req.user (set by protect()).
 * @param {...string} roles
 */
function requireRole(...roles) {
  const allowed = new Set((roles || []).map((r) => String(r || "").trim()).filter(Boolean));
  return (req, res, next) => {
    if (!req.user) {
      res.status(401);
      return next(new Error("Unauthorized"));
    }
    if (!allowed.has(String(req.user.role || "").trim())) {
      res.status(403);
      return next(new Error("Forbidden"));
    }
    return next();
  };
}

module.exports = { protect, requireRole, invalidateUserAuthCache };
