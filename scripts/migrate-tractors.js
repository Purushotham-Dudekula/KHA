/* eslint-disable no-console */
/**
 * One-time migration for legacy Tractor documents.
 *
 * Mappings implemented:
 * - owner -> operatorId
 * - isVerified:
 *    - true  -> approved
 *    - false -> pending
 * - legacy fields to new names:
 *    - tractorModel -> model
 *    - machineryType -> machineryTypes (array)
 *    - pollutionCertificate -> pollutionDocument
 *    - fitnessCertificate -> fitnessDocument
 * - drivingLicense:
 *    - moved to operator.drivingLicenseDocument if operator has it missing
 *
 * After migration we also set:
 * - isAvailable -> true (if missing) so approved tractors can appear in nearby listings
 */

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const { env } = require("../src/config/env");
const User = require("../src/models/user.model");
const Tractor = require("../src/models/tractor.model");

function toObjectIdMaybe(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function main() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is required in .env to run this migration.");
  }
  await connectDB(env.mongoUri);

  const tractorCollection = mongoose.connection.collection(Tractor.collection.name);
  const userCollection = mongoose.connection.collection(User.collection.name);

  // 1) Move drivingLicense from tractors to operator if missing on user.
  let operatorsUpdated = 0;
  const licenseRows = await tractorCollection
    .find({ drivingLicense: { $exists: true, $ne: "" } })
    .project({ owner: 1, operatorId: 1, drivingLicense: 1 })
    .toArray();

  const drivingLicenseByOperator = new Map();
  for (const row of licenseRows) {
    const operatorId = row.operatorId || row.owner;
    const oid = toObjectIdMaybe(operatorId);
    if (!oid) continue;
    if (!drivingLicenseByOperator.has(oid.toString())) {
      drivingLicenseByOperator.set(oid.toString(), String(row.drivingLicense).trim());
    }
  }

  for (const [operatorId, drivingLicense] of drivingLicenseByOperator.entries()) {
    if (!drivingLicense) continue;
    const result = await userCollection.updateOne(
      {
        _id: new mongoose.Types.ObjectId(operatorId),
        $or: [
          { drivingLicenseDocument: { $exists: false } },
          { drivingLicenseDocument: "" },
          { drivingLicenseDocument: null },
        ],
      },
      { $set: { drivingLicenseDocument: drivingLicense } }
    );
    if (result.modifiedCount > 0) operatorsUpdated += result.modifiedCount;
  }

  // 2) Update all tractors:
  //    - set operatorId, verificationStatus, isAvailable, rename fields.
  const tractorsUpdateResult = await tractorCollection.updateMany(
    {},
    [
      {
        $set: {
          operatorId: { $ifNull: ["$operatorId", "$owner"] },
          verificationStatus: {
            $ifNull: [
              "$verificationStatus",
              { $cond: [{ $eq: ["$isVerified", true] }, "approved", "pending"] },
            ],
          },
          isAvailable: { $ifNull: ["$isAvailable", true] },

          model: { $ifNull: ["$model", "$tractorModel"] },
          brand: { $ifNull: ["$brand", "unknown"] },

          machineryTypes: {
            $cond: [
              { $isArray: "$machineryTypes" },
              "$machineryTypes",
              {
                $cond: [
                  { $and: [{ $ne: ["$machineryType", null] }, { $ne: ["$machineryType", ""] }] },
                  ["$machineryType"],
                  [],
                ],
              },
            ],
          },

          pollutionDocument: { $ifNull: ["$pollutionDocument", "$pollutionCertificate"] },
          fitnessDocument: { $ifNull: ["$fitnessDocument", "$fitnessCertificate"] },
        },
      },
    ]
  );

  // 3) Cleanup legacy fields now that we copied them.
  const tractorsUnsetResult = await tractorCollection.updateMany(
    {},
    {
      $unset: {
        owner: "",
        tractorModel: "",
        machineryType: "",
        pollutionCertificate: "",
        fitnessCertificate: "",
        isVerified: "",
        drivingLicense: "",
      },
    }
  );

  console.log("Tractor migration complete.");
  console.log(`- tractors updated (set stage): ${tractorsUpdateResult.modifiedCount}`);
  console.log(`- tractors updated (unset stage): ${tractorsUnsetResult.modifiedCount}`);
  console.log(`- operator documents updated (DL move): ${operatorsUpdated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });

