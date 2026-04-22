function requireAdmin(req, res, next) {
  if (!req.admin) {
    res.status(401);
    return next(new Error("Unauthorized"));
  }
  if (req.admin.role !== "admin" && req.admin.role !== "super_admin") {
    res.status(403);
    return next(new Error("Admin access required"));
  }
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.admin) {
    res.status(401);
    return next(new Error("Unauthorized"));
  }
  if (req.admin.role !== "super_admin") {
    res.status(403);
    return next(new Error("Super admin access required"));
  }
  return next();
}

module.exports = { requireAdmin, requireSuperAdmin };
