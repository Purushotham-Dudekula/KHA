/** Stable codes + copy for clients (edge cases & recovery). */
module.exports = {
  NO_OPERATORS_NEARBY: {
    code: "NO_OPERATORS_NEARBY",
    message: "No operators available in this area right now.",
    userTip: "Try increasing the search radius, moving slightly on the map, or try again later.",
    retryable: true,
  },
  OPERATOR_BUSY: {
    code: "OPERATOR_BUSY",
    message: "This operator already has an active job.",
    userTip: "Pick another operator or try again after their current booking ends.",
    retryable: true,
  },
  SLOT_TAKEN: {
    code: "SLOT_TAKEN",
    message: "That time slot is already booked for this operator.",
    userTip: "Choose a different date or time.",
    retryable: true,
  },
  DUPLICATE_BOOKING: {
    code: "DUPLICATE_BOOKING",
    message: "You already have an active booking.",
    userTip: "Finish or cancel your current booking before creating a new one.",
    retryable: false,
  },
  PAYMENT_FAILED: {
    code: "PAYMENT_FAILED",
    message: "Payment could not be completed.",
    userTip: "Check your connection and payment method, then retry. If it persists, contact support.",
    retryable: true,
  },
  BOOKING_FAILED: {
    code: "BOOKING_FAILED",
    message: "Booking could not be created.",
    userTip: "Please verify details and try again.",
    retryable: true,
  },
  NETWORK_OR_SERVER: {
    code: "NETWORK_OR_SERVER",
    message: "Something went wrong on our side.",
    userTip: "Please try again in a moment.",
    retryable: true,
  },
  OPERATOR_LAST_MINUTE_CANCEL: {
    code: "OPERATOR_LAST_MINUTE_CANCEL",
    message: "The operator cancelled this booking.",
    userTip: "You can book another operator. If payment was taken, check refund status on the booking.",
    retryable: true,
  },
};
