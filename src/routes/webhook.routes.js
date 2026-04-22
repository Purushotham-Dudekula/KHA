const express = require("express");
const { razorpayWebhook } = require("../controllers/razorpayWebhook.controller");

const router = express.Router();

// Razorpay webhook signature requires the raw body.
// Raw body is captured globally via express.json({ verify }) in app.js.
router.post("/razorpay", razorpayWebhook);

module.exports = router;

