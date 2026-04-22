const { env } = require("../config/env");

/** Payments feature gate (set via validateEnv from ENABLE_PAYMENTS). */
function isPaymentsEnabled() {
  return Boolean(env.enablePayments);
}

/** Email feature gate (ENABLE_EMAILS). */
function isEmailsEnabled() {
  return Boolean(env.enableEmails);
}

/** Push/socket notification gate (ENABLE_NOTIFICATIONS). */
function isNotificationsEnabled() {
  return Boolean(env.enableNotifications);
}

module.exports = {
  isPaymentsEnabled,
  isEmailsEnabled,
  isNotificationsEnabled,
};
