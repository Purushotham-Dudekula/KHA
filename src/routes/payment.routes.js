const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const { listMyPayments } = require("../controllers/payment.controller");

const router = express.Router();

router.get("/my", protect, listMyPayments);

module.exports = router;
