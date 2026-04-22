/** @typedef {import("joi")} Joi */

/**
 * @param {Joi.ObjectSchema} schema
 * @param {"body"|"query"|"params"} source
 */
function validate(schema, source = "body") {
  return (req, res, next) => {
    const payload =
      source === "body" ? req.body : source === "query" ? req.query : req.params;

    const { error, value } = schema.validate(payload, {
      abortEarly: false,
      stripUnknown: false,
    });

    if (error) {
      const message = error.details.map((d) => d.message.replace(/"/g, "")).join("; ");
      res.status(400);
      return next(new Error(message));
    }

    if (source === "body") req.body = value;
    else if (source === "query") Object.assign(req.query, value);
    else Object.assign(req.params, value);

    return next();
  };
}

module.exports = { validate };
