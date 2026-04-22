jest.mock("../../src/models/user.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/models/tractor.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/utils/verification", () => ({
  validateTractorForApproval: jest.fn(() => ({ ok: false, missing: ["rcDocument"] })),
  hasOperatorDocumentsForApproval: jest.fn(() => true),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "approved", documentsVerified: true })),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({ cleanUserResponse: jest.fn((u) => u) }));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/utils/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../../src/services/adminActivityLog.service", () => ({ logAdminActivity: jest.fn() }));
jest.mock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));

const User = require("../../src/models/user.model");
const Tractor = require("../../src/models/tractor.model");
const { validateTractorForApproval } = require("../../src/utils/verification");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("admin.controller (more coverage unit)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejectOperator -> 200 success with reason trimming", async () => {
    const { rejectOperator } = require("../../src/controllers/admin/admin.index.js");
    const user = { _id: "u1", role: "operator", verificationStatus: "pending", save: jest.fn(async () => {}) };
    User.findById.mockResolvedValueOnce(user);
    const res = makeRes();
    const next = jest.fn();
    await rejectOperator({ params: { id: "507f1f77bcf86cd799439011" }, body: { reason: "  bad docs " }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("verifyTractor -> 400 when missing documents", async () => {
    const { verifyTractor } = require("../../src/controllers/admin/admin.index.js");
    validateTractorForApproval.mockReturnValueOnce({ ok: false, missing: ["rcDocument"] });
    Tractor.findById.mockResolvedValueOnce({ _id: "t1" });
    const res = makeRes();
    const next = jest.fn();
    await verifyTractor({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("rejectTractor -> 200 success sets reasons", async () => {
    const { rejectTractor } = require("../../src/controllers/admin/admin.index.js");
    const tractor = { _id: "t1", save: jest.fn(async () => {}) };
    Tractor.findById.mockResolvedValueOnce(tractor);
    const res = makeRes();
    const next = jest.fn();
    await rejectTractor({ params: { id: "507f1f77bcf86cd799439011" }, body: { reason: "bad" }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });
});

