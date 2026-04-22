const Joi = require("joi");

function normalizePhone(value, helpers) {
  const s = String(value).trim();
  if (!/^\d{10}$/.test(s)) {
    return helpers.error("any.invalid");
  }
  return s;
}

function normalizeOtp(value, helpers) {
  const s = String(value).trim();
  if (!/^\d{6}$/.test(s)) {
    return helpers.error("any.invalid");
  }
  return s;
}

const sendOtp = Joi.object({
  phone: Joi.any().required().custom(normalizePhone).messages({
    "any.invalid": "Phone must be a valid 10-digit number.",
  }),
});

const verifyOtp = Joi.object({
  phone: Joi.any().required().custom(normalizePhone).messages({
    "any.invalid": "Phone must be a valid 10-digit number.",
  }),
  otp: Joi.any().required().custom(normalizeOtp).messages({
    "any.invalid": "OTP must be 6 digits.",
  }),
});

const refreshToken = Joi.object({
  refreshToken: Joi.string().trim().min(1).optional(),
}).unknown(true);

module.exports = { sendOtp, verifyOtp, refreshToken };
