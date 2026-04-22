const Joi = require("joi");

const objectId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({ "string.length": "must be a valid ID." });

function rejectDuplicateTypeNames(types, helpers) {
  if (!Array.isArray(types)) return types;
  const seen = new Set();
  for (const t of types) {
    const key = String(t?.name || "").trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      return helpers.error("any.custom");
    }
    seen.add(key);
  }
  return types;
}

const createService = Joi.object({
  types: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().lowercase().min(1).required(),
        pricePerHour: Joi.number().min(0).optional(),
        pricePerAcre: Joi.number().min(0).optional(),
        image: Joi.string().trim().allow("").optional(),
      }).unknown(false)
    )
    .custom(rejectDuplicateTypeNames)
    .optional(),
  name: Joi.string().trim().min(1).required(),
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).required(),
  pricePerHour: Joi.number().min(0).optional(),
  pricePerAcre: Joi.number().min(0).optional(),
  image: Joi.string().trim().allow("").optional(),
  isActive: Joi.boolean().optional(),
})
  .or("pricePerHour", "pricePerAcre")
  .messages({ "object.missing": "pricePerHour and/or pricePerAcre is required" })
.messages({ "any.custom": "Duplicate service type not allowed" })
  .unknown(false);

const updateService = Joi.object({
  types: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().lowercase().min(1).required(),
        pricePerHour: Joi.number().min(0).optional(),
        pricePerAcre: Joi.number().min(0).optional(),
        image: Joi.string().trim().allow("").optional(),
      }).unknown(false)
    )
    .custom(rejectDuplicateTypeNames)
    .optional(),
  name: Joi.string().trim().min(1).optional(),
  pricePerHour: Joi.number().min(0).optional(),
  pricePerAcre: Joi.number().min(0).optional(),
  image: Joi.string().trim().allow("").optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "any.custom": "Duplicate service type not allowed" })
  .unknown(false);

const toggleService = Joi.object({
  isActive: Joi.boolean().required(),
}).unknown(false);

const serviceIdParam = Joi.object({
  id: objectId.required(),
}).unknown(false);

module.exports = {
  createService,
  updateService,
  toggleService,
  serviceIdParam,
};
