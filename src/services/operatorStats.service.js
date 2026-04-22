const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const Review = require("../models/review.model");
const User = require("../models/user.model");

async function getOperatorReliabilityMetrics(operatorId) {
  const oid =
    operatorId instanceof mongoose.Types.ObjectId
      ? operatorId
      : new mongoose.Types.ObjectId(String(operatorId));

  const bookings = await Booking.find({ operator: oid })
    .select("status cancelledBy createdAt respondedAt")
    .lean();

  const rejected = bookings.filter((b) => b.status === "rejected");
  const acceptedPath = bookings.filter((b) =>
    [
      "accepted",
      "confirmed",
      "en_route",
      "in_progress",
      "completed",
      "payment_pending",
      "closed",
    ].includes(b.status)
  );

  let acceptanceRate = null;
  if (rejected.length + acceptedPath.length > 0) {
    acceptanceRate = acceptedPath.length / (acceptedPath.length + rejected.length);
  }

  const operatorCancels = bookings.filter(
    (b) => b.status === "cancelled" && b.cancelledBy === "operator"
  ).length;
  const nonPending = bookings.filter((b) => b.status !== "pending").length;
  const operatorCancellationRate = nonPending > 0 ? operatorCancels / nonPending : null;

  const responseHours = bookings
    .filter((b) => b.respondedAt && b.createdAt)
    .map((b) => (new Date(b.respondedAt).getTime() - new Date(b.createdAt).getTime()) / 3600000);
  const avgResponseHours =
    responseHours.length > 0
      ? responseHours.reduce((a, x) => a + x, 0) / responseHours.length
      : null;

  let reliability = "average";
  const decisions = acceptedPath.length + rejected.length;
  if (
    decisions >= 5 &&
    acceptanceRate != null &&
    acceptanceRate >= 0.85 &&
    (operatorCancellationRate ?? 0) <= 0.08 &&
    (avgResponseHours == null || avgResponseHours <= 72)
  ) {
    reliability = "reliable";
  } else if (
    decisions >= 3 &&
    ((acceptanceRate != null && acceptanceRate < 0.45) || (operatorCancellationRate ?? 0) > 0.25)
  ) {
    reliability = "unreliable";
  }

  const reliabilityRank = reliability === "reliable" ? 0 : reliability === "unreliable" ? 2 : 1;

  return {
    reliability,
    reliabilityRank,
    acceptanceRate:
      acceptanceRate != null ? Math.round(acceptanceRate * 1000) / 1000 : null,
    operatorCancellationRate:
      operatorCancellationRate != null
        ? Math.round(operatorCancellationRate * 1000) / 1000
        : null,
    avgResponseHours:
      avgResponseHours != null ? Math.round(avgResponseHours * 10) / 10 : null,
  };
}

async function syncOperatorRatingFromReviews(operatorId) {
  const oid =
    operatorId instanceof mongoose.Types.ObjectId
      ? operatorId
      : new mongoose.Types.ObjectId(String(operatorId));

  const agg = await Review.aggregate([
    { $match: { operator: oid } },
    { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);

  const row = agg[0];
  const averageRating = row ? Math.round(row.avg * 100) / 100 : 0;
  const reviewCount = row ? row.count : 0;

  await User.findByIdAndUpdate(oid, {
    averageRating,
    reviewCount,
  });

  return { averageRating, reviewCount };
}

function sortOperatorsByTrust(rows) {
  return [...rows].sort((a, b) => {
    const rr = (a.reliabilityRank ?? 1) - (b.reliabilityRank ?? 1);
    if (rr !== 0) return rr;
    const ar = (b.averageRating ?? 0) - (a.averageRating ?? 0);
    if (ar !== 0) return ar;
    return (a.distance ?? 0) - (b.distance ?? 0);
  });
}

/**
 * @param {{ onlineOperators: object[], offlineOperators: object[] }} partitions
 */
async function enrichOperatorPartitions(partitions) {
  const all = [...partitions.onlineOperators, ...partitions.offlineOperators];
  const ids = [...new Set(all.map((o) => o._id.toString()))];

  const users = await User.find({ _id: { $in: ids } })
    .select("averageRating reviewCount verificationStatus aadhaarVerified")
    .lean();
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  const metricsList = await Promise.all(ids.map((id) => getOperatorReliabilityMetrics(id)));
  const metricMap = new Map(ids.map((id, i) => [id, metricsList[i]]));

  const enrich = (o) => {
    const id = o._id.toString();
    const u = userMap.get(id) || {};
    const m = metricMap.get(id) || { reliability: "average", reliabilityRank: 1 };
    return {
      ...o,
      averageRating: u.averageRating ?? o.averageRating ?? 0,
      reviewCount: u.reviewCount ?? o.reviewCount ?? 0,
      reliability: m.reliability,
      reliabilityRank: m.reliabilityRank,
      acceptanceRate: m.acceptanceRate,
      operatorCancellationRate: m.operatorCancellationRate,
      avgResponseHours: m.avgResponseHours,
    };
  };

  return {
    onlineOperators: sortOperatorsByTrust(partitions.onlineOperators.map(enrich)),
    offlineOperators: sortOperatorsByTrust(partitions.offlineOperators.map(enrich)),
  };
}

module.exports = {
  getOperatorReliabilityMetrics,
  syncOperatorRatingFromReviews,
  enrichOperatorPartitions,
};
