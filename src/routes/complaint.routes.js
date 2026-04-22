const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const { validate } = require("../middleware/validate.middleware");
const complaintValidation = require("../validations/complaint.validation");
const { createComplaint, listMyComplaints } = require("../controllers/complaint.controller");

const router = express.Router();

router.post("/", protect, validate(complaintValidation.createComplaint), createComplaint);
router.get("/", protect, listMyComplaints);

module.exports = router;
