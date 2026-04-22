const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const { validate } = require("../middleware/validate.middleware");
const userValidation = require("../validations/user.validation");
const { uploadOperatorDocs } = require("../middleware/upload.middleware");


const {
  getMe,
  selectRole,
  updateFarmerProfile,
  updateOperatorProfile,
  uploadOperatorDocuments,
  updateLocation,
  updateStatus,
  updateLanguage,
  updateFcmToken,
  getNearbyOperators,
  getOperatorPublicProfile,
  getFarmerDashboard,
} = require("../controllers/user.controller");

const router = express.Router();

router.get("/me", protect, getMe);
router.post("/select-role", protect, validate(userValidation.selectRole), selectRole);
router.post("/profile/farmer", protect, validate(userValidation.updateFarmerProfile), updateFarmerProfile);
router.post("/profile/operator", protect, validate(userValidation.updateOperatorProfile), updateOperatorProfile);
router.patch(
  "/profile/operator/documents",
  protect,
  uploadOperatorDocs,
  uploadOperatorDocuments
);
router.patch("/location", protect, validate(userValidation.updateLocation), updateLocation);
router.patch("/status", protect, validate(userValidation.updateStatus), updateStatus);
router.patch("/language", protect, validate(userValidation.updateLanguage), updateLanguage);
router.post("/fcm-token", protect, validate(userValidation.updateFcmToken), updateFcmToken);
router.get("/dashboard", protect, getFarmerDashboard);
router.get("/nearby-operators", protect, validate(userValidation.nearbyOperatorsQuery, "query"), getNearbyOperators);
router.get("/operators/:operatorId", protect, getOperatorPublicProfile);

module.exports = router;
