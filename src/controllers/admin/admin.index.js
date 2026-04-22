const admin_refund_controller = require("./admin.refund.controller.js");
const admin_commission_controller = require("./admin.commission.controller.js");
const admin_operator_controller = require("./admin.operator.controller.js");
const admin_tractor_controller = require("./admin.tractor.controller.js");
const admin_core_controller = require("./admin.core.controller.js");

module.exports = {
  ...admin_refund_controller,
  ...admin_commission_controller,
  ...admin_operator_controller,
  ...admin_tractor_controller,
  ...admin_core_controller,
};
