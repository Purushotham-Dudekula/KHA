const Joi = require("joi");

const objectId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({ "string.length": "must be a valid ID." });

const positiveNumericLike = Joi.alternatives()
  .try(Joi.number().positive(), Joi.string().trim())
  .custom((val, helpers) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return helpers.error("any.invalid");
    return val;
  }, "positive numeric validator")
  .messages({ "any.invalid": "must be a positive number." });

const createBooking = Joi.object({
  // Backward-compatible:
  // - Old clients send both `operatorId` + `tractorId`.
  // - New behavior allows sending only `tractorId` (backend derives operatorId from the tractor).
  operatorId: objectId.optional(),
  tractorId: objectId.optional(),
  serviceType: Joi.string().trim().lowercase().min(1).required(),
  type: Joi.string().trim().lowercase().min(1).optional(),
  subtype: Joi.string().trim().lowercase().min(1).optional(),
  date: Joi.alternatives()
    .try(Joi.date().iso(), Joi.date(), Joi.string().trim().min(1))
    .required(),
  time: Joi.string()
    .trim()
    .pattern(/^([01]?\d|2[0-3]):([0-5]\d)$/)
    .required(),
  landArea: positiveNumericLike.optional(),
  address: Joi.string().allow("").optional(),
  hours: positiveNumericLike.optional(),
  baseAmount: Joi.number().optional(),
  totalAmount: Joi.number().optional(),
})
  // Must provide at least one of tractorId/operatorId
  .or("tractorId", "operatorId")
  // Keep existing operator-based flow unchanged:
  // if `operatorId` is provided, `tractorId` must also be present.
  .with("operatorId", "tractorId")
  .unknown(true);

const estimateBooking = Joi.object({
  landArea: positiveNumericLike.required(),
  serviceType: Joi.string().trim().lowercase().min(1).required(),
  type: Joi.string().trim().lowercase().min(1).optional(),
  subtype: Joi.string().trim().lowercase().min(1).optional(),
  hours: positiveNumericLike.optional(),
}).unknown(true);

const payBooking = Joi.object({
  // Backward compatible: if paymentMethod is omitted, treat it as "upi".
  // Cash is never allowed; it must return 400 with "Cash payments are not supported".
  paymentMethod: Joi.string()
    .trim()
    .optional()
    .default("upi")
    .custom((val, helpers) => {
      const v = String(val).toLowerCase();
      if (v === "cash") return helpers.error("cash_not_supported");
      if (v !== "upi") return helpers.error("invalid_payment_method");
      return "upi";
    }, "payment method validator")
    .messages({
      "cash_not_supported": "Cash payments are not supported",
      "invalid_payment_method": 'paymentMethod must be "upi"',
    }),
  transactionId: Joi.alternatives()
    .try(Joi.string().trim().max(128), Joi.number())
    .optional()
    .allow("", null),
  orderId: Joi.alternatives().try(Joi.string().trim().max(128), Joi.number()).optional().allow("", null),
  paymentId: Joi.alternatives()
    .try(Joi.string().trim().max(128), Joi.number())
    .optional()
    .allow("", null),
  signature: Joi.alternatives()
    .try(Joi.string().trim().max(512), Joi.number())
    .optional()
    .allow("", null),
  razorpay_signature: Joi.alternatives()
    .try(Joi.string().trim().max(512), Joi.number())
    .optional()
    .allow("", null),
}).unknown(true);

const cancelBooking = Joi.object({
  reason: Joi.string().allow("").optional(),
}).unknown(true);

const startJob = Joi.object({
  phase: Joi.alternatives().try(Joi.string().trim(), Joi.valid(null)).optional(),
}).unknown(true);

const completeJob = Joi.object({
  finalAmount: Joi.alternatives().try(Joi.number().positive(), Joi.string().trim()).optional().allow(null, ""),
  priceDifferenceReason: Joi.string().allow("").optional(),
}).unknown(true);

const respondBooking = Joi.object({
  action: Joi.string().trim().lowercase().valid("accept", "reject").required(),
}).unknown(true);

const updateProgress = Joi.object({
  progress: Joi.number().valid(25, 50, 75, 100).required(),
  images: Joi.array()
    .items(
      Joi.alternatives().try(
        Joi.string().trim().allow(""),
        Joi.object({
          url: Joi.string().trim().required(),
        }).unknown(true),
        Joi.object({ buffer: Joi.binary().required() }).unknown(true)
      )
    )
    .max(5)
    .optional(),
}).unknown(true);

const submitReview = Joi.object({
  rating: Joi.alternatives().try(Joi.number().integer().min(1).max(5), Joi.string().trim()).required(),
  review: Joi.string().allow("").max(2000).optional(),
}).unknown(true);

module.exports = {
  createBooking,
  estimateBooking,
  payBooking,
  cancelBooking,
  startJob,
  completeJob,
  respondBooking,
  updateProgress,
  submitReview,
};
