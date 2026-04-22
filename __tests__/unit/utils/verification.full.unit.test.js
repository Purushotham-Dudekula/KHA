const {
  hasOperatorDocumentsForApproval,
  isFutureDate,
  validateTractorForApproval,
  deriveTractorVerificationFromDocuments,
} = require("../../../src/utils/verification");

describe("verification utils", () => {
  test("hasOperatorDocumentsForApproval branches", () => {
    expect(hasOperatorDocumentsForApproval(null)).toBe(false);
    expect(hasOperatorDocumentsForApproval({})).toBe(false);
    expect(
      hasOperatorDocumentsForApproval({
        aadhaarNumber: "123456789012",
        aadhaarDocument: "u1",
        drivingLicenseDocument: "u2",
      })
    ).toBe(true);
  });

  test("isFutureDate branches", () => {
    expect(isFutureDate(null)).toBe(false);
    expect(isFutureDate("not-a-date")).toBe(false);
    expect(isFutureDate(new Date(Date.now() + 86400000))).toBe(true);
    expect(isFutureDate(new Date(Date.now() - 86400000))).toBe(false);
  });

  test("validateTractorForApproval collects missing fields", () => {
    const { ok, missing } = validateTractorForApproval({
      rcDocument: "",
      insuranceDocument: "a",
      pollutionDocument: "b",
      fitnessDocument: "c",
      tractorPhoto: "d",
      insuranceExpiry: new Date(Date.now() + 86400000),
      pollutionExpiry: new Date(Date.now() + 86400000),
      fitnessExpiry: new Date(Date.now() + 86400000),
    });
    expect(ok).toBe(false);
    expect(missing).toContain("rcDocument");
  });

  test("deriveTractorVerificationFromDocuments", () => {
    expect(
      deriveTractorVerificationFromDocuments({
        rcVerificationStatus: "rejected",
        insuranceVerificationStatus: "approved",
      })
    ).toEqual({ verificationStatus: "rejected", documentsVerified: false });
    expect(
      deriveTractorVerificationFromDocuments({
        rcVerificationStatus: "approved",
        insuranceVerificationStatus: "approved",
        pollutionVerificationStatus: "approved",
        fitnessVerificationStatus: "approved",
      })
    ).toEqual({ verificationStatus: "approved", documentsVerified: true });
    expect(
      deriveTractorVerificationFromDocuments({
        rcVerificationStatus: "approved",
        insuranceVerificationStatus: "pending",
      })
    ).toEqual({ verificationStatus: "pending", documentsVerified: false });
  });
});
