/**
 * Rules for admin approval of operators and tractors.
 */

function hasOperatorDocumentsForApproval(user) {
  if (!user) return false;
  const aadhaarOk = String(user.aadhaarNumber || "").replace(/\s/g, "").length === 12;
  const aadhaarDoc = String(user.aadhaarDocument || "").trim();
  const dlDoc = String(user.drivingLicenseDocument || "").trim();
  return aadhaarOk && aadhaarDoc.length > 0 && dlDoc.length > 0;
}

/**
 * @param {Date | string | null | undefined} d
 */
function isFutureDate(d) {
  if (d == null) return false;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

/**
 * All documents and future expiries required before tractor approval.
 * @param {import("mongoose").Document | Record<string, unknown>} tractor
 * @returns {{ ok: boolean, missing: string[] }}
 */
function validateTractorForApproval(tractor) {
  const missing = [];
  const t = tractor && typeof tractor.toObject === "function" ? tractor.toObject() : { ...tractor };

  if (!String(t.rcDocument || "").trim()) missing.push("rcDocument");
  if (!String(t.insuranceDocument || "").trim()) missing.push("insuranceDocument");
  if (!String(t.pollutionDocument || "").trim()) missing.push("pollutionDocument");
  if (!String(t.fitnessDocument || "").trim()) missing.push("fitnessDocument");
  if (!String(t.tractorPhoto || "").trim()) missing.push("tractorPhoto");

  if (!isFutureDate(t.insuranceExpiry)) missing.push("insuranceExpiry");
  if (!isFutureDate(t.pollutionExpiry)) missing.push("pollutionExpiry");
  if (!isFutureDate(t.fitnessExpiry)) missing.push("fitnessExpiry");

  return { ok: missing.length === 0, missing };
}

/**
 * Derives tractor-level status from per-document statuses.
 * @param {import("mongoose").Document | Record<string, unknown>} tractor
 * @returns {{ verificationStatus: "pending" | "approved" | "rejected", documentsVerified: boolean }}
 */
function deriveTractorVerificationFromDocuments(tractor) {
  const t = tractor && typeof tractor.toObject === "function" ? tractor.toObject() : { ...tractor };
  const statuses = [
    String(t.rcVerificationStatus || "pending"),
    String(t.insuranceVerificationStatus || "pending"),
    String(t.pollutionVerificationStatus || "pending"),
    String(t.fitnessVerificationStatus || "pending"),
  ];

  if (statuses.some((s) => s === "rejected")) {
    return { verificationStatus: "rejected", documentsVerified: false };
  }
  if (statuses.every((s) => s === "approved")) {
    return { verificationStatus: "approved", documentsVerified: true };
  }
  return { verificationStatus: "pending", documentsVerified: false };
}

module.exports = {
  hasOperatorDocumentsForApproval,
  validateTractorForApproval,
  isFutureDate,
  deriveTractorVerificationFromDocuments,
};
