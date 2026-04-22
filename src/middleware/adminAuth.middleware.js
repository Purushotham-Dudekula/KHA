const jwt = require("jsonwebtoken");
const Admin = require("../models/admin.model");

/**
 * Verifies JWT issued by admin OTP login (`POST /api/admin/verify-otp`, scope: admin). Sets req.admin (password excluded).
 */
async function protectAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      res.status(401);
      throw new Error("Unauthorized. Token missing.");
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.scope !== "admin") {
      res.status(401);
      throw new Error("Invalid admin token.");
    }

    const admin = await Admin.findById(decoded.id).select("-password");
    if (!admin) {
      res.status(401);
      throw new Error("Unauthorized. Admin not found.");
    }
    if (admin.isActive !== true) {
      res.status(403);
      throw new Error("Admin account is deactivated.");
    }

    req.admin = admin;
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      res.status(401);
      return next(new Error("Unauthorized. Invalid or expired token."));
    }
    return next(error);
  }
}

module.exports = { protectAdmin };
