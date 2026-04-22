const User = require("../models/user.model");
const { enrichOperatorPartitions } = require("./operatorStats.service");
const { logger } = require("../utils/logger");

function sortByDistance(a, b) {
  return (a.distance ?? 0) - (b.distance ?? 0);
}

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Nearby operators listing.
 * The source of truth for availability is the Tractor collection (never `user.tractor`).
 */
async function findNearbyOperators(lat, lng, radiusKm, serviceType = null) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  const radiusInKm = Number(radiusKm);
  const MAX_RADIUS_KM = 50;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(radiusInKm) ||
    radiusInKm <= 0
  ) {
    throw new Error("lat, lng and radiusKm must be valid numbers.");
  }

  const effectiveRadius = radiusInKm > MAX_RADIUS_KM ? MAX_RADIUS_KM : radiusInKm;
  if (radiusInKm > MAX_RADIUS_KM) {
    logger.warn("Nearby operators radius too large; capping for safety", {
      requestedKm: radiusInKm,
      cappedKm: MAX_RADIUS_KM,
    });
  }

  const maxDistance = effectiveRadius * 1000;

  const operators = await User.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [longitude, latitude] },
        distanceField: "distanceMeters",
        maxDistance,
        spherical: true,
        query: {
          role: "operator",
          verificationStatus: "approved",
          isBlocked: { $ne: true },
          location: { $exists: true, $ne: null },
        },
      },
    },
    {
      $set: { distance: "$distanceMeters" },
    },
    { $unset: "distanceMeters" },
  ]);

  logger.info(`Operators: ${operators.length}`);

  // Cap results post-fetch (do not change aggregation pipeline shape).
  const MAX_OPERATORS = 50;
  const cappedOperators = operators.length > MAX_OPERATORS ? operators.slice(0, MAX_OPERATORS) : operators;
  if (operators.length > MAX_OPERATORS) {
    logger.warn("Nearby operators result set too large; capping for safety", {
      total: operators.length,
      capped: MAX_OPERATORS,
    });
  }

  // Defensive: aggregation results should be unique per operator,
  // but keep a stable, de-duped list to prevent downstream duplication.
  const seenOperatorIds = new Set();
  const uniqueOperators = [];
  for (const o of cappedOperators) {
    const id = o?._id ? String(o._id) : null;
    if (!id) continue;
    if (seenOperatorIds.has(id)) continue;
    seenOperatorIds.add(id);
    uniqueOperators.push(o);
  }

  const operatorIds = uniqueOperators.map((o) => o._id);
  if (operatorIds.length === 0) {
    return enrichOperatorPartitions({ onlineOperators: [], offlineOperators: [] });
  }

  // Fetch tractors separately (scalable relational design).
  const Tractor = require("../models/tractor.model");
  const tractorsQuery = {
    operatorId: { $in: operatorIds },
    isAvailable: true,
    verificationStatus: "approved",
    isDeleted: { $ne: true },
  };

  const tractors = await Tractor.find(tractorsQuery)
    .select(
      "operatorId tractorType brand model registrationNumber machineryTypes machinerySubTypes tractorPhoto verificationStatus isAvailable insuranceExpiry pollutionExpiry fitnessExpiry"
    )
    .lean();

  logger.info("Nearby tractors fetched before service filtering", {
    tractorsFetched: tractors.length,
  });

  const normalizedServiceType = normalizeCode(serviceType);

  const tractorsByOperator = new Map();
  const seenTractorIdsByOperator = new Map();
  for (const t of tractors) {
    if (!t.operatorId) continue;
    const id = String(t.operatorId);
    const tractorId = t._id ? String(t._id) : null;
    if (!tractorId) continue;

    // Defensive: query already filters these, but keep post-fetch safeguards.
    if (t.verificationStatus !== "approved") continue;
    if (t.isAvailable !== true) continue;

    const normalizedMachineryTypes = Array.isArray(t.machineryTypes)
      ? t.machineryTypes.map((x) => normalizeCode(x)).filter(Boolean)
      : [];
    if (normalizedServiceType && !normalizedMachineryTypes.includes(normalizedServiceType)) {
      continue;
    }

    const normalizedMachinerySubTypes = Array.isArray(t.machinerySubTypes)
      ? t.machinerySubTypes.map((x) => normalizeCode(x)).filter(Boolean)
      : [];

    // De-dupe tractors per operator (prevents duplicates from any upstream joins/merges).
    const seenTractors = seenTractorIdsByOperator.get(id) || new Set();
    if (seenTractors.has(tractorId)) continue;
    seenTractors.add(tractorId);
    seenTractorIdsByOperator.set(id, seenTractors);

    const row = {
      tractorId: t._id,
      tractorType: t.tractorType,
      brand: t.brand,
      model: t.model,
      registrationNumber: t.registrationNumber,
      machineryTypes: normalizedMachineryTypes,
      machinerySubTypes: normalizedMachinerySubTypes,
      tractorPhoto: t.tractorPhoto ?? "",
      verificationStatus: t.verificationStatus ?? (t.isVerified ? "approved" : "pending"),
      isAvailable: t.isAvailable === true,
      insuranceExpiry: t.insuranceExpiry ?? null,
      pollutionExpiry: t.pollutionExpiry ?? null,
      fitnessExpiry: t.fitnessExpiry ?? null,
    };
    const list = tractorsByOperator.get(id) || [];
    list.push(row);
    tractorsByOperator.set(id, list);
  }

  let filteredTractorCount = 0;
  for (const list of tractorsByOperator.values()) {
    filteredTractorCount += Array.isArray(list) ? list.length : 0;
  }
  const operatorsWithoutTractors = uniqueOperators.filter(
    (o) => !tractorsByOperator.has(String(o._id))
  ).length;
  logger.info("Nearby filtering stats", {
    serviceType: normalizedServiceType || null,
    operatorsFetched: uniqueOperators.length,
    tractorsBeforeFiltering: tractors.length,
    tractorsAfterFiltering: filteredTractorCount,
    operatorsRemovedNoTractors: operatorsWithoutTractors,
  });

  // Do not return operators without eligible tractors after filtering.
  const eligibleOperators = uniqueOperators.filter((o) => tractorsByOperator.has(String(o._id)));

  const onlineOperators = eligibleOperators
    .filter((o) => o.isOnline === true)
    .sort(sortByDistance)
    .map((o) => ({ ...o, tractors: tractorsByOperator.get(String(o._id)) || [] }));

  const offlineOperators = eligibleOperators
    .filter((o) => o.isOnline !== true)
    .sort(sortByDistance)
    .map((o) => ({ ...o, tractors: tractorsByOperator.get(String(o._id)) || [] }));

  return enrichOperatorPartitions({ onlineOperators, offlineOperators });
}

module.exports = { findNearbyOperators };
