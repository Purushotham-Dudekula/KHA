const Joi = require("joi");

const notificationIdParam = Joi.object({
  id: Joi.string().trim().hex().length(24).required(),
}).unknown(false);

module.exports = {
  notificationIdParam,
};
