const Joi = require("joi");

const objectId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({ "string.length": "must be a valid ID." });

const rejectReason = Joi.object({
  reason: Joi.string().allow("").optional(),
}).unknown(true);

const blockUser = Joi.object({
  isBlocked: Joi.boolean().optional(),
}).unknown(true);

const respondComplaint = Joi.object({
  adminResponse: Joi.string().trim().min(1).required(),
  status: Joi.string().valid("in_progress", "resolved").required(),
})
  .unknown(true);

const upsertPricing = Joi.object({
  serviceType: Joi.string().trim().min(1).required(),
  pricePerAcre: Joi.number().min(0).optional(),
  pricePerHour: Joi.number().min(0).optional(),
})
  .or("pricePerAcre", "pricePerHour")
  .messages({
    "object.missing": "Provide pricePerAcre and/or pricePerHour.",
  })
  .unknown(true);

const upsertCommission = Joi.object({
  percentage: Joi.alternatives().try(Joi.number(), Joi.string().trim()).required(),
  active: Joi.boolean().optional(),
}).unknown(true);

const createOffer = Joi.object({
  title: Joi.string().trim().min(1).required(),
  description: Joi.string().trim().min(1).required(),
  discountPercentage: Joi.alternatives().try(Joi.number(), Joi.string().trim()).required(),
  startDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).required(),
  endDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).required(),
  isActive: Joi.boolean().optional(),
})
  .unknown(true);

const updateOffer = Joi.object({
  title: Joi.string().trim().min(1).optional(),
  description: Joi.string().trim().min(1).optional(),
  discountPercentage: Joi.number().min(0).max(100).optional(),
  startDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).optional(),
  endDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field is required for update." })
  .unknown(true);

const upsertSeasonalPricing = Joi.object({
  serviceType: Joi.string().trim().min(1).required(),
  startDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).required(),
  endDate: Joi.alternatives().try(Joi.date(), Joi.string().trim()).required(),
  multiplier: Joi.number().greater(0).required(),
}).unknown(false);

const adminCreateTractor = Joi.object({
  operatorId: objectId.required(),
  tractorType: Joi.string().valid("small", "medium", "large", "extra_large").required(),
  brand: Joi.string().trim().min(1).required(),
  model: Joi.string().trim().min(1).required(),
  registrationNumber: Joi.string().trim().min(1).required(),
  machineryTypes: Joi.array().items(Joi.string().trim().min(1)).min(1).required(),
  machinerySubTypes: Joi.array().items(Joi.string().trim().min(1)).optional(),
  tractorPhoto: Joi.string().trim().allow("").optional(),
  isAvailable: Joi.boolean().optional(),
  verificationStatus: Joi.string().valid("pending", "approved", "rejected").optional(),
}).unknown(false);

const adminUpdateTractor = Joi.object({
  operatorId: objectId.optional(),
  tractorType: Joi.string().valid("small", "medium", "large", "extra_large").optional(),
  brand: Joi.string().trim().min(1).optional(),
  model: Joi.string().trim().min(1).optional(),
  registrationNumber: Joi.string().trim().min(1).optional(),
  machineryTypes: Joi.array().items(Joi.string().trim().min(1)).min(1).optional(),
  machinerySubTypes: Joi.array().items(Joi.string().trim().min(1)).optional(),
  tractorPhoto: Joi.string().trim().allow("").optional(),
  isAvailable: Joi.boolean().optional(),
  verificationStatus: Joi.string().valid("pending", "approved", "rejected").optional(),
  documentsVerified: Joi.boolean().optional(),
  isDeleted: Joi.boolean().optional(),
})
  .min(1)
  .unknown(false);

const adminUserBody = Joi.object({
  name: Joi.string().trim().min(1).required(),
  email: Joi.string().trim().email().required(),
  // Password-based authentication is disabled; accept optional legacy field without requiring it.
  password: Joi.string().min(6).optional(),
}).unknown(false);

const adminLogin = Joi.object({
  email: Joi.string().trim().email().required(),
}).unknown(false);

const forgotPassword = Joi.object({
  email: Joi.string().trim().email().required(),
}).unknown(false);

const verifyAdminOtp = Joi.object({
  email: Joi.string().trim().email().required(),
  otp: Joi.alternatives().try(Joi.string().trim(), Joi.number()).required(),
}).unknown(false);

const resetAdminPassword = Joi.object({
  email: Joi.string().trim().email().required(),
  newPassword: Joi.string().min(6).required(),
  resetToken: Joi.string().trim().min(1).required(),
}).unknown(false);

const tractorAdminVerification = Joi.object({
  status: Joi.string().valid("approved", "rejected").required(),
}).unknown(true);

const verifyTractorDocument = Joi.object({
  documentType: Joi.string().valid("rc", "insurance", "pollution", "fitness").required(),
  status: Joi.string().valid("approved", "rejected", "pending").required(),
  reason: Joi.string().trim().max(500).allow("").optional(),
}).unknown(false);

const paramId = Joi.object({
  id: objectId.required(),
});

const broadcastNotification = Joi.object({
  title: Joi.string().trim().min(1).required(),
  message: Joi.string().trim().min(1).required(),
  // Optional targeting (non-breaking): if omitted, broadcast to all users.
  role: Joi.string().trim().valid("farmer", "operator").optional(),
  userIds: Joi.array()
    .items(objectId)
    .max(5000)
    .optional(),
}).unknown(false);

const refundDecision = Joi.object({
  action: Joi.string().valid("approve", "reject").required(),
  refundReason: Joi.string().trim().min(1).required(),
}).unknown(false);

const verifyOperatorDocuments = Joi.object({
  aadhaarStatus: Joi.string().valid("approved", "rejected").required(),
  licenseStatus: Joi.string().valid("approved", "rejected").required(),
  reason: Joi.string().trim().max(500).allow("").optional(),
}).unknown(false);

const adminStatusUpdate = Joi.object({
  active: Joi.boolean().required(),
}).unknown(false);

module.exports = {
  rejectReason,
  blockUser,
  respondComplaint,
  upsertPricing,
  upsertCommission,
  upsertSeasonalPricing,
  adminCreateTractor,
  adminUpdateTractor,
  createOffer,
  updateOffer,
  adminUserBody,
  adminLogin,
  forgotPassword,
  verifyAdminOtp,
  resetAdminPassword,
  tractorAdminVerification,
  verifyTractorDocument,
  paramId,
  broadcastNotification,
  refundDecision,
  verifyOperatorDocuments,
  adminStatusUpdate,
};
