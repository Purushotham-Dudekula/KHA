const Joi = require("joi");

const objectId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({ "string.length": "must be a valid ID." });

const documentInput = Joi.alternatives().try(
  Joi.string().allow(""),
  Joi.object({ buffer: Joi.binary().required() }).unknown(true)
);

const createTractor = Joi.object({
  tractorType: Joi.string().valid("small", "medium", "large", "extra_large").required(),
  brand: Joi.string().trim().min(1).required(),
  model: Joi.string().trim().min(1).required(),
  registrationNumber: Joi.string().trim().min(1).required(),
  machineryTypes: Joi.array()
    .items(Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/))
    .min(1)
    .required()
    .messages({
      "array.base": "At least one valid service type is required",
      "array.min": "At least one valid service type is required",
      "any.required": "At least one valid service type is required",
      "string.pattern.base": "At least one valid service type is required",
    }),
  machinerySubTypes: Joi.array().items(Joi.string().trim().min(1)).optional(),
  tractorPhoto: Joi.alternatives().try(Joi.string(), Joi.object({ buffer: Joi.binary().required() }).unknown(true)).optional().allow("", null),
  isAvailable: Joi.boolean().optional(),
}).unknown(true);

const uploadTractorDocuments = Joi.object({
  rcDocument: documentInput.optional(),
  insuranceDocument: documentInput.optional(),
  pollutionDocument: documentInput.optional(),
  fitnessDocument: documentInput.optional(),
  insuranceExpiry: Joi.alternatives().try(Joi.date(), Joi.string().trim()).optional().allow(null, ""),
  pollutionExpiry: Joi.alternatives().try(Joi.date(), Joi.string().trim()).optional().allow(null, ""),
  fitnessExpiry: Joi.alternatives().try(Joi.date(), Joi.string().trim()).optional().allow(null, ""),
  tractorPhoto: documentInput.optional(),
}).unknown(true);

const setTractorAvailability = Joi.object({
  isAvailable: Joi.boolean().required(),
}).unknown(false);

const verificationParams = Joi.object({
  tractorId: objectId.required(),
});

const updateTractorBasics = Joi.object({
  brand: Joi.string().trim().min(1).optional(),
  model: Joi.string().trim().min(1).optional(),
  machineryTypes: Joi.array()
    .items(Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/))
    .min(1)
    .optional()
    .messages({
      "array.base": "At least one valid service type is required",
      "array.min": "At least one valid service type is required",
      "string.pattern.base": "At least one valid service type is required",
    }),
  machinerySubTypes: Joi.array().items(Joi.string().trim().min(1)).optional(),
  availability: Joi.boolean().optional(),
})
  .min(1)
  .unknown(false);

module.exports = {
  createTractor,
  uploadTractorDocuments,
  setTractorAvailability,
  verificationParams,
  updateTractorBasics,
};
