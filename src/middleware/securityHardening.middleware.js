function securityHardening() {
  const enabled = String(process.env.ENABLE_SECURITY_HARDENING || "true").trim().toLowerCase() !== "false";
  if (!enabled) return (_req, _res, next) => next();

  // Lazy require so install is optional in dev environments.
  const mongoSanitize = require("express-mongo-sanitize");

  const safeMongoSanitize = (req, _res, next) => {
    // express-mongo-sanitize middleware reassigns req.query, which can be read-only.
    // Sanitizing the existing objects in place avoids that runtime error.
    ["body", "params", "headers", "query"].forEach((key) => {
      if (req[key] && typeof req[key] === "object") {
        mongoSanitize.sanitize(req[key]);
      }
    });
    next();
  };

  return [
    safeMongoSanitize,
  ];
}

module.exports = { securityHardening };

