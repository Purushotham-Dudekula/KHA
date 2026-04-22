const express = require("express");
const { buildLimiter } = require("../middleware/rateLimit.middleware");
const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const tractorRoutes = require("./tractor.routes");
const bookingRoutes = require("./booking.routes");
const notificationRoutes = require("./notification.routes");
const adminRoutes = require("./admin.routes");
const superAdminRoutes = require("./super-admin.routes");
const complaintRoutes = require("./complaint.routes");
const operatorRoutes = require("./operator.routes");
const supportRoutes = require("./support.routes");
const offersRoutes = require("./offers.routes");
const paymentRoutes = require("./payment.routes");
const servicesRoutes = require("./services.routes");
const webhookRoutes = require("./webhook.routes");

const router = express.Router();

const authRouteLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  // Stricter limits for auth-sensitive endpoints.
  maxAuthenticated: 120,
  maxUnauthenticated: 40,
  message: "Too many auth requests from this IP. Please try again later.",
});

const paymentRouteLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  maxAuthenticated: 120,
  maxUnauthenticated: 40,
  message: "Too many payment requests from this IP. Please try again later.",
});

function mountApiRoutes(basePath) {
  if (process.env.NODE_ENV === "development") {
    router.use(`${basePath}/dev`, require("./dev.routes"));
  }

  router.use(`${basePath}/auth`, authRouteLimiter, authRoutes);
  router.use(`${basePath}/user`, userRoutes);
  router.use(`${basePath}/tractor`, tractorRoutes);
  router.use(`${basePath}/bookings`, bookingRoutes);
  router.use(`${basePath}/notifications`, notificationRoutes);
  router.use(`${basePath}/admin`, adminRoutes);
  router.use(`${basePath}/super-admin`, superAdminRoutes);
  router.use(`${basePath}/complaints`, complaintRoutes);
  router.use(`${basePath}/operator`, operatorRoutes);
  router.use(`${basePath}/support`, supportRoutes);
  router.use(`${basePath}/offers`, offersRoutes);
  router.use(`${basePath}/payments`, paymentRouteLimiter, paymentRoutes);
  router.use(`${basePath}/services`, servicesRoutes);
  router.use(`${basePath}/webhooks`, webhookRoutes);
}

// Versioned routes for clients.
mountApiRoutes("/api/v1");

module.exports = router;
