const Joi = require("joi");

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const updateBankDetails = Joi.object({
  accountHolderName: Joi.string().trim().allow("").optional(),
  accountNumber: Joi.string().trim().min(1).required(),
  ifsc: Joi.string()
    .trim()
    .uppercase()
    .required()
    .custom((val, helpers) => {
      const v = String(val).replace(/\s/g, "").toUpperCase();
      if (!IFSC_RE.test(v)) {
        return helpers.error("any.invalid");
      }
      return v;
    }, "IFSC format")
    .messages({ "any.invalid": "ifsc must be a valid 11-character IFSC." }),
  upiId: Joi.string().trim().allow("").optional(),
}).unknown(false);

const updateLocation = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
}).unknown(true);

module.exports = {
  updateBankDetails,
  updateLocation,
};
