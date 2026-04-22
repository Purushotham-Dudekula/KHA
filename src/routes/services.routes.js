const express = require("express");
const { protectAdmin } = require("../middleware/adminAuth.middleware");
const { requireAdmin } = require("../middleware/admin.middleware");
const { validate } = require("../middleware/validate.middleware");
const servicesValidation = require("../validations/services.validation");
const {
  listActiveServices,
  listAllServices,
  createService,
  updateService,
  toggleServiceStatus,
} = require("../controllers/services.controller");

const router = express.Router();

router.get("/", listActiveServices);
router.get("/all", listAllServices);
router.post(
  "/admin",
  protectAdmin,
  requireAdmin,
  validate(servicesValidation.createService),
  createService
);
router.patch(
  "/admin/:id",
  protectAdmin,
  requireAdmin,
  validate(servicesValidation.serviceIdParam, "params"),
  validate(servicesValidation.updateService),
  updateService
);
router.patch(
  "/admin/:id/toggle",
  protectAdmin,
  requireAdmin,
  validate(servicesValidation.serviceIdParam, "params"),
  validate(servicesValidation.toggleService),
  toggleServiceStatus
);

module.exports = router;

