const express = require("express");
const multer = require("multer");
const { protect } = require("../middleware/auth.middleware");
const { protectAdmin } = require("../middleware/adminAuth.middleware");
const { requireAdmin } = require("../middleware/admin.middleware");
const { validate } = require("../middleware/validate.middleware");
const { validateTractorServiceTypes } = require("../middleware/serviceValidation.middleware");
const tractorValidation = require("../validations/tractor.validation");
const adminValidation = require("../validations/admin.validation");


const {
  createTractor,
  uploadTractorDocuments,
  getMyTractors,
  getTractorById,
  setTractorAvailability,
  updateTractorBasics,
  adminSetTractorVerification,
  deleteTractor,
} = require("../controllers/tractor.controller");

const router = express.Router();


router.post(
  "/",
  protect,
  validate(tractorValidation.createTractor),
  validateTractorServiceTypes,
  createTractor
);
router.get("/", protect, getMyTractors);
router.get("/my-tractors", protect, getMyTractors);
router.get("/details/:id", protect, getTractorById);
// Backward compatible alias: same handler and response as /details/:id
router.get("/:id", protect, getTractorById);
router.delete("/:id", protect, deleteTractor);
const upload = multer({ storage: multer.memoryStorage() });
router.patch(
  "/:id/documents",
  protect,
  upload.fields([
    { name: "rcDocument", maxCount: 1 },
    { name: "insuranceDocument", maxCount: 1 },
    { name: "pollutionDocument", maxCount: 1 },
    { name: "fitnessDocument", maxCount: 1 },
    { name: "tractorPhoto", maxCount: 1 },
  ]),
  uploadTractorDocuments
);
router.patch("/:id/availability", protect, validate(tractorValidation.setTractorAvailability), setTractorAvailability);
router.patch(
  "/:id",
  protect,
  validate(tractorValidation.updateTractorBasics),
  validateTractorServiceTypes,
  updateTractorBasics
);
router.patch(
  "/:tractorId/verification",
  protectAdmin,
  requireAdmin,
  validate(tractorValidation.verificationParams, "params"),
  validate(adminValidation.tractorAdminVerification),
  adminSetTractorVerification
);

module.exports = router;
