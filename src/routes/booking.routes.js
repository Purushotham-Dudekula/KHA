const express = require("express");
const rateLimit = require("express-rate-limit");
const { protect, requireRole } = require("../middleware/auth.middleware");
const { validate } = require("../middleware/validate.middleware");
const { validateBookingServiceType } = require("../middleware/serviceValidation.middleware");
const { idempotencyGuard } = require("../middleware/idempotency.middleware");
const bookingValidation = require("../validations/booking.validation");
const {
  createBooking,
  respondToBooking,
  startJob,
  completeJob,
  cancelBooking,
  payAdvance,
  payRemaining,
  getBookingRefundPreview,
  getBookingDetails,
  getBookingInvoice,
  listFarmerBookings,
  listOperatorBookings,
  listMyFarmerBookings,
  estimateBooking,
  trackBooking,
  updateBookingProgress,
} = require("../controllers/booking/booking.index.js");
const { submitReview } = require("../controllers/review.controller");
const { uploadProgressImages } = require("../middleware/upload.middleware");

const router = express.Router();

const bookingPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many payment attempts from this IP. Please try again later.",
    });
  },
});

router.post(
  "/create",
  protect,
  requireRole("farmer"),
  idempotencyGuard(),
  validate(bookingValidation.createBooking),
  validateBookingServiceType,
  createBooking
);
router.post(
  "/estimate",
  protect,
  validate(bookingValidation.estimateBooking),
  validateBookingServiceType,
  estimateBooking
);
router.get("/farmer", protect, listFarmerBookings);
router.get("/operator", protect, listOperatorBookings);
router.post("/:id/review", protect, validate(bookingValidation.submitReview), submitReview);
router.get("/:id/track", protect, trackBooking);
router.get("/my-bookings", protect, listMyFarmerBookings);
router.get("/:id/refund-preview", protect, getBookingRefundPreview);
router.get("/:id", protect, getBookingDetails);
router.get("/:id/invoice", protect, getBookingInvoice);
router.patch(
  "/:id/progress",
  protect,
  uploadProgressImages,
  validate(bookingValidation.updateProgress),
  updateBookingProgress
);
router.post(
  "/:id/pay-advance",
  bookingPaymentLimiter,
  protect,
  idempotencyGuard(),
  validate(bookingValidation.payBooking),
  payAdvance
);
router.post(
  "/:id/pay-remaining",
  bookingPaymentLimiter,
  protect,
  idempotencyGuard(),
  validate(bookingValidation.payBooking),
  payRemaining
);
router.post("/:id/cancel", protect, validate(bookingValidation.cancelBooking), cancelBooking);
router.patch("/:id/start", protect, validate(bookingValidation.startJob), startJob);
router.patch("/:id/complete", protect, validate(bookingValidation.completeJob), completeJob);
router.post(
  "/:id/respond",
  protect,
  requireRole("operator"),
  validate(bookingValidation.respondBooking),
  respondToBooking
);

module.exports = router;
