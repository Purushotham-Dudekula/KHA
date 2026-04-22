const Joi = require("joi");

const objectId = Joi.string().trim().hex().length(24);

const createComplaint = Joi.object({
  bookingId: objectId.optional().allow(null, ""),
  message: Joi.string().trim().min(1).max(2000).required(),
  category: Joi.alternatives().try(Joi.string().trim().min(1), Joi.number()).required(),
  images: Joi.alternatives()
    .try(
      Joi.array()
        .items(
          Joi.alternatives().try(
            Joi.string().trim().uri(),
            Joi.object({ url: Joi.string().trim().uri().required() }).unknown(true),
            Joi.object({ buffer: Joi.binary().required() }).unknown(true)
          )
        )
        .max(5),
      Joi.string().trim().uri(),
      Joi.object({ url: Joi.string().trim().uri().required() }).unknown(true),
      Joi.object({ buffer: Joi.binary().required() }).unknown(true)
    )
    .optional(),
}).unknown(false);

module.exports = {
  createComplaint,
};
