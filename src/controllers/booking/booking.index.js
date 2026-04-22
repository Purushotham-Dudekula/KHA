const booking_create_controller = require("./booking.create.controller.js");
const booking_payment_controller = require("./booking.payment.controller.js");
const booking_status_controller = require("./booking.status.controller.js");
const booking_query_controller = require("./booking.query.controller.js");

module.exports = {
  ...booking_create_controller,
  ...booking_payment_controller,
  ...booking_status_controller,
  ...booking_query_controller,
};
