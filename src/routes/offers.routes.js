const express = require("express");
const { getOffers, getActiveOffers } = require("../controllers/offers.controller");

const router = express.Router();

// Public offers for home screen.
router.get("/", getOffers);
router.get("/active", getActiveOffers);

module.exports = router;

