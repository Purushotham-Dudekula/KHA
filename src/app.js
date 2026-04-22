const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");

const healthRoutes = require("./routes/health.routes");
const routes = require("./routes");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { requestLogger } = require("./middleware/requestLogger.middleware");
const { requestTimeout } = require("./middleware/requestTimeout.middleware");
const { globalApiLimiter } = require("./middleware/rateLimit.middleware");
const { withRequestContext } = require("./utils/requestContext");
const { env } = require("./config/env");
const swaggerUi = require("swagger-ui-express");
const openApiSpec = require("./swagger/openapi.spec");
const { securityHardening } = require("./middleware/securityHardening.middleware");
const { metricsMiddleware } = require("./middleware/metrics.middleware");
const { initSentry } = require("./services/sentry.service");
const { mongoConnectionSafety } = require("./middleware/mongoConnectionSafety.middleware");

function buildCorsOptions() {
  const origins = env.corsOrigins || [];
  if (origins.length === 0) {
    return { origin: false, credentials: false };
  }
  if (origins.length === 1) {
    return { origin: origins[0], credentials: true };
  }
  return {
    origin: (requestOrigin, cb) => {
      if (!requestOrigin) {
        return cb(null, true);
      }
      if (origins.includes(requestOrigin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  };
}

function createApp() {
  const app = express();
  const metrics = metricsMiddleware();
  initSentry(app);

  // So req.ip reflects client IP behind one proxy (NGINX, Render, AWS ALB) and rate limits key correctly.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        const accept = String(req.headers.accept || "").toLowerCase();
        if (
          accept.includes("image/") ||
          accept.includes("video/") ||
          accept.includes("audio/") ||
          accept.includes("application/zip") ||
          accept.includes("application/gzip") ||
          accept.includes("application/pdf") ||
          accept.includes("application/octet-stream")
        ) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );
  app.use(healthRoutes);
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/v1/")) {
      return next();
    }
    return res.status(400).json({ error: "API version required. Use /api/v1/" });
  });
  app.use(globalApiLimiter);
  app.use(securityHardening());
  app.use(metrics.middleware);
  app.use(
    express.json({
      limit: "10kb",
      verify: (req, _res, buf) => {
        // Needed for webhook signature verification.
        // Buffer is small for typical webhooks; do not log.
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: "10kb" }));
  app.use(requestLogger);
  app.use(withRequestContext);
  app.use(requestTimeout(10_000));
  app.use(mongoConnectionSafety());

  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "KH Agriconnect API",
    })
  );

  if (metrics.handler) {
    app.get(
      "/metrics",
      (req, res, next) => {
        const secret = String(process.env.METRICS_SECRET || "").trim();
        const provided = String(
          req.headers["metrics_secret"] || req.headers["metrics-secret"] || ""
        ).trim();
        if (!secret || provided !== secret) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        next();
      },
      metrics.handler
    );
  }

  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
