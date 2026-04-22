/* eslint-disable no-console */
/**
 * One-time migration to clean duplicate Payment documents
 * before applying unique constraint on { bookingId, type }.
 *
 * Strategy:
 * - Group payments by { bookingId, type }
 * - For each group with duplicates:
 *   - keep the latest SUCCESS payment
 *   - if no SUCCESS exists, keep the latest payment by createdAt
 *   - delete all other documents in that group
 * - Log the deleted record ids per group
 */

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const { env } = require("../src/config/env");
const Payment = require("../src/models/payment.model");

async function main() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is required in .env to run this script.");
  }

  await connectDB(env.mongoUri);
  const paymentCollection = mongoose.connection.collection(Payment.collection.name);

  // Find duplicate groups and choose a deterministic keeper by sorting:
  // 1) success payments first
  // 2) most recent createdAt
  // 3) most recent _id
  const duplicateGroups = await paymentCollection
    .aggregate([
      {
        $addFields: {
          isSuccess: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
        },
      },
      {
        $sort: { isSuccess: -1, createdAt: -1, _id: -1 },
      },
      {
        $group: {
          _id: { bookingId: "$bookingId", type: "$type" },
          count: { $sum: 1 },
          keepId: { $first: "$_id" },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      {
        $project: {
          _id: 0,
          bookingId: "$_id.bookingId",
          type: "$_id.type",
          count: 1,
          keepId: 1,
          ids: 1,
        },
      },
    ])
    .toArray();

  console.log(`Duplicate payment groups found: ${duplicateGroups.length}`);

  let totalDeleted = 0;
  let totalGroupsProcessed = 0;

  for (const group of duplicateGroups) {
    totalGroupsProcessed += 1;
    const { bookingId, type, keepId, ids, count } = group;
    const keepIdStr = keepId?.toString?.() ?? String(keepId);
    const deleteIds = ids.filter((x) => (x?.toString?.() ?? String(x)) !== keepIdStr);

    if (!deleteIds.length) {
      console.log(
        `- group bookingId=${bookingId} type=${type} count=${count}: nothing to delete (keeper already unique)`
      );
      continue;
    }

    const deleteResult = await paymentCollection.deleteMany({
      _id: { $in: deleteIds },
    });

    totalDeleted += deleteResult.deletedCount || 0;

    console.log(
      `- group bookingId=${bookingId} type=${type} count=${count} keep=${keepIdStr} deleted=${deleteResult.deletedCount}`
    );
    console.log(`  deletedIds: ${deleteIds.map((id) => id.toString()).join(", ")}`);
  }

  console.log("Duplicate payments cleanup complete.");
  console.log(`- groups processed: ${totalGroupsProcessed}`);
  console.log(`- total deleted payments: ${totalDeleted}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Payment cleanup failed:", err);
    process.exit(1);
  });

