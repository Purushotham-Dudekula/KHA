/* eslint-disable no-console */
/**
 * One-time migration: drop legacy unique index { operator: 1, date: 1, time: 1 }
 *
 * Why:
 * - App now enforces slot uniqueness using { tractor: 1, date: 1, time: 1 }.
 * - If the old operator-based unique index still exists in MongoDB, it can cause
 *   duplicate-key errors for legitimate bookings and conflict with the new logic.
 *
 * Safety:
 * - Does NOT run automatically at startup.
 * - Only drops the index if it exists and matches the legacy key pattern.
 */
const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const { env } = require("../src/config/env");
const Booking = require("../src/models/booking.model");

function isLegacyOperatorSlotUniqueIndex(idx) {
  const key = idx?.key || {};
  return Boolean(idx?.unique && key?.operator === 1 && key?.date === 1 && key?.time === 1);
}

async function main() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is required in .env to run this script.");
  }

  await connectDB(env.mongoUri);

  const bookingCollection = mongoose.connection.collection(Booking.collection.name);
  const indexes = await bookingCollection.indexes();

  const legacy = Array.isArray(indexes) ? indexes.find(isLegacyOperatorSlotUniqueIndex) : null;

  if (!legacy) {
    console.log("Legacy booking index not found. Nothing to drop.");
    return;
  }

  const indexName = String(legacy.name || "").trim();
  console.log(`Legacy booking index found: name=${indexName} key=${JSON.stringify(legacy.key)}`);

  try {
    await bookingCollection.dropIndex(indexName);
    console.log("Legacy booking index dropped successfully.");
  } catch (err) {
    console.error("Failed to drop legacy booking index:", err?.message || String(err));
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("dropOldBookingIndex failed:", err);
    process.exit(1);
  });

