const { env } = require("../config/env");

function requireDevelopmentOnly(req, res, next) {
  if (process.env.NODE_ENV !== "development") {
    res.status(403);
    return next(new Error("Forbidden."));
  }

  const provided = req.headers["x-dev-secret"];
  if (!env.devRouteSecret || typeof provided !== "string" || provided !== env.devRouteSecret) {
    res.status(403);
    return next(new Error("Forbidden."));
  }

  return next();
}

module.exports = { requireDevelopmentOnly };
