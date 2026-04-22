const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const { validate } = require("../middleware/validate.middleware");
const operatorValidation = require("../validations/operator.validation");
const {
  getOperatorEarnings,
  getOperatorEarningsHistory,
  updateOperatorLocation,
  updateOperatorBankDetails,
} = require("../controllers/operator.controller");
const { listMyOperatorBookings } = require("../controllers/booking/booking.index.js");

const router = express.Router();

router.get("/earnings", protect, getOperatorEarnings);
router.get("/earnings-history", protect, getOperatorEarningsHistory);
router.get("/my-bookings", protect, listMyOperatorBookings);
router.post("/location", protect, validate(operatorValidation.updateLocation), updateOperatorLocation);
router.patch(
  "/bank-details",
  protect,
  validate(operatorValidation.updateBankDetails),
  updateOperatorBankDetails
);

module.exports = router;
