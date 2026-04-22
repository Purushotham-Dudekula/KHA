const LedgerTransaction = require("../models/transaction.model");
const { logger } = require("../utils/logger");

const SUCCESS_ALIASES = ["completed", "processed", "approved"];
const FAILED_ALIASES = ["error", "errored", "rejected", "declined"];
const REFUNDED_ALIASES = ["refund", "refunded_success", "refund_success"];

async function migrateTransactionStatuses() {
  try {
    const updates = [
      {
        to: "success",
        values: SUCCESS_ALIASES,
      },
      {
        to: "failed",
        values: FAILED_ALIASES,
      },
      {
        to: "refunded",
        values: REFUNDED_ALIASES,
      },
    ];

    for (const rule of updates) {
      await LedgerTransaction.updateMany(
        { status: { $in: rule.values } },
        { $set: { status: rule.to } }
      );
    }

    await LedgerTransaction.updateMany(
      { status: { $nin: ["pending", "success", "failed", "refunded"] } },
      { $set: { status: "pending" } }
    );
  } catch (error) {
    logger.warn("Ledger transaction status migration failed", {
      message: error?.message || String(error),
    });
  }
}

module.exports = { migrateTransactionStatuses };
