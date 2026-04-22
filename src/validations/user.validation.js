const Joi = require("joi");

const updateFarmerProfile = Joi.object({
  name: Joi.string().trim().min(1).required(),
  village: Joi.string().trim().min(1).required(),
  mandal: Joi.string().trim().min(1).required(),
  district: Joi.string().trim().min(1).required(),
  state: Joi.string().trim().min(1).required(),
  pincode: Joi.string().trim().pattern(/^\d{6}$/).required(),
  landArea: Joi.alternatives()
    .try(Joi.number().positive().required(), Joi.string().trim().required())
    .custom((val, helpers) => {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) return helpers.error("any.invalid");
      return val;
    }, "positive landArea")
    .required(),
  primaryCrop: Joi.string().allow("").optional(),
  soilType: Joi.string().allow("").optional(),
})
  .messages({
    "string.pattern.base": "pincode must be a valid 6-digit number.",
    "any.invalid": "landArea must be greater than 0.",
  })
  .unknown(true);

const selectRole = Joi.object({
  role: Joi.string().valid("farmer", "operator").required(),
}).unknown(true);

const updateOperatorProfile = Joi.object({
  name: Joi.string().trim().min(1).required(),
  village: Joi.string().trim().min(1).required(),
  mandal: Joi.string().trim().min(1).required(),
  district: Joi.string().trim().min(1).required(),
  state: Joi.string().trim().min(1).required(),
  pincode: Joi.string().trim().pattern(/^\d{6}$/).required(),
  experience: Joi.string()
    .valid("less_than_1", "1_3", "3_5", "5_10", "10_plus")
    .required(),
  education: Joi.string().trim().min(1).required(),
  aadhaarNumber: Joi.string()
    .required()
    .custom((val, helpers) => {
      const d = String(val).replace(/\s/g, "");
      if (!/^\d{12}$/.test(d)) {
        return helpers.error("any.invalid");
      }
      return val;
    }, "aadhaar digits")
    .messages({ "any.invalid": "aadhaarNumber must be exactly 12 digits." }),
  aadhaarDocument: Joi.string().trim().optional(),
  landArea: Joi.any().forbidden(),
  primaryCrop: Joi.any().forbidden(),
  soilType: Joi.any().forbidden(),
  verificationStatus: Joi.any().forbidden(),
  aadhaarVerified: Joi.any().forbidden(),
  drivingLicenseDocument: Joi.any().forbidden(),
})
  .messages({
    "string.pattern.base": "pincode must be a valid 6-digit number.",
  })
  .unknown(true);

const uploadOperatorDocuments = Joi.object({
  aadhaarDocument: Joi.alternatives()
    .try(
      Joi.string().trim().min(1),
      Joi.object({ buffer: Joi.binary().required() }).unknown(true)
    )
    .required(),
  drivingLicenseDocument: Joi.alternatives()
    .try(
      Joi.string().trim().min(1),
      Joi.object({ buffer: Joi.binary().required() }).unknown(true)
    )
    .required(),
}).unknown(true);

const updateLocation = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
}).unknown(true);

const nearbyOperatorsQuery = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  radius: Joi.number().positive().required(),
  serviceType: Joi.string().trim().optional(),
  type: Joi.string().trim().optional(),
}).unknown(true);

const updateStatus = Joi.object({
  isOnline: Joi.boolean().required(),
}).unknown(true);

const updateLanguage = Joi.object({
  language: Joi.string().valid("en", "te", "hi").required(),
}).unknown(false);

const updateFcmToken = Joi.object({
  fcmToken: Joi.string().trim().min(1).required(),
}).unknown(false);

module.exports = {
  updateFarmerProfile,
  selectRole,
  updateOperatorProfile,
  uploadOperatorDocuments,
  updateLocation,
  nearbyOperatorsQuery,
  updateStatus,
  updateLanguage,
  updateFcmToken,
};
