const express = require("express");
const { getSupport } = require("../controllers/support.controller");

const router = express.Router();

router.get("/", getSupport);

module.exports = router;
