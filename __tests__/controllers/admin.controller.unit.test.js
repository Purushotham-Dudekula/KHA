jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose");
  return { ...actual, Types: actual.Types };
});

jest.mock("../../src/models/admin.model", () => ({
  exists: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
}));
jest.mock("../../src/models/tractor.model", () => ({}));
jest.mock("../../src/models/booking.model", () => ({}));
jest.mock("../../src/models/complaint.model", () => ({}));
jest.mock("../../src/models/payment.model", () => ({
  findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
}));
jest.mock("../../src/models/pricing.model", () => ({}));
jest.mock("../../src/models/commission.model", () => ({}));
jest.mock("../../src/models/seasonalPricing.model", () => ({}));
jest.mock("../../src/models/adminAuditLog.model", () => ({}));
jest.mock("../../src/models/adminActivityLog.model", () => ({}));

jest.mock("../../src/services/adminAuditLog.service", () => ({
  logAdminAction: jest.fn(),
}));
jest.mock("../../src/services/adminActivityLog.service", () => ({
  logAdminActivity: jest.fn(),
}));
jest.mock("../../src/services/auditLog.service", () => ({
  logAuditAction: jest.fn(),
}));
jest.mock("../../src/services/notification.service", () => ({
  notifyUser: jest.fn(),
}));
jest.mock("../../src/services/payment.service", () => ({
  refundUpiPayment: jest.fn(),
}));
jest.mock("../../src/services/ledger.service", () => ({
  logRefundSuccess: jest.fn(),
}));
jest.mock("../../src/utils/refundCalculation", () => ({
  resolveRefundSnapshot: jest.fn(),
}));
jest.mock("../../src/services/storage.service", () => ({
  getSecureFileUrl: jest.fn(),
}));
jest.mock("../../src/middleware/auth.middleware", () => ({
  invalidateUserAuthCache: jest.fn(),
}));
jest.mock("../../src/utils/verification", () => ({
  hasOperatorDocumentsForApproval: jest.fn(),
  validateTractorForApproval: jest.fn(() => ({ ok: true, missing: [] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({
  cleanUserResponse: jest.fn((u) => u),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((_res, status, _msg, data) => _res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mongoose = require("mongoose");
const Admin = require("../../src/models/admin.model");
const User = require("../../src/models/user.model");
const { AppError } = require("../../src/utils/AppError");
const verification = require("../../src/utils/verification");

describe("admin.controller (unit)", () => {
  function makeRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("createAdmin -> 400 when name missing (AppError via next)", async () => {
    const { createAdmin } = require("../../src/controllers/admin/admin.index.js");
    const next = jest.fn();
    await createAdmin({ body: { email: "a@b.com" }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  test("createAdmin -> 409 when email exists", async () => {
    const { createAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.exists.mockResolvedValueOnce(true);
    const next = jest.fn();
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(409);
  });

  test("createAdmin -> 201 success", async () => {
    const { createAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.exists.mockResolvedValueOnce(false);
    Admin.create.mockResolvedValueOnce({
      _id: new mongoose.Types.ObjectId(),
      toObject: () => ({ _id: "id", name: "n", email: "a@b.com", role: "admin", isActive: true }),
    });
    const res = makeRes();
    const next = jest.fn();
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  test("createAdmin -> 409 when duplicate key error code 11000", async () => {
    const { createAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.exists.mockResolvedValueOnce(false);
    const err = new Error("dup");
    err.code = 11000;
    Admin.create.mockRejectedValueOnce(err);
    const next = jest.fn();
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(409);
  });

  test("deactivateAdmin -> 400 invalid id", async () => {
    const { deactivateAdmin } = require("../../src/controllers/admin/admin.index.js");
    const next = jest.fn();
    await deactivateAdmin({ params: { id: "bad" }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  test("deactivateAdmin -> 404 not found", async () => {
    const { deactivateAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.findById.mockResolvedValueOnce(null);
    const next = jest.fn();
    await deactivateAdmin({ params: { id: new mongoose.Types.ObjectId().toString() }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  test("deactivateAdmin -> 403 cannot manage super_admin", async () => {
    const { deactivateAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.findById.mockResolvedValueOnce({ role: "super_admin" });
    const next = jest.fn();
    await deactivateAdmin({ params: { id: new mongoose.Types.ObjectId().toString() }, admin: { _id: "a1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  test("deactivateAdmin -> 400 cannot deactivate yourself", async () => {
    const { deactivateAdmin } = require("../../src/controllers/admin/admin.index.js");
    const myId = new mongoose.Types.ObjectId();
    Admin.findById.mockResolvedValueOnce({
      _id: myId,
      role: "admin",
      isActive: true,
      save: jest.fn(),
    });
    const next = jest.fn();
    await deactivateAdmin({ params: { id: myId.toString() }, admin: { _id: myId } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  test("verifyOperator -> 400 invalid id", async () => {
    const { verifyOperator } = require("../../src/controllers/admin/admin.index.js");
    const res = makeRes();
    const next = jest.fn();
    await verifyOperator({ params: { id: "bad" }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("verifyOperator -> 404 operator not found", async () => {
    const { verifyOperator } = require("../../src/controllers/admin/admin.index.js");
    User.findById.mockResolvedValueOnce(null);
    const res = makeRes();
    const next = jest.fn();
    await verifyOperator({ params: { id: new mongoose.Types.ObjectId().toString() }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("verifyOperator -> 400 when documents missing", async () => {
    const { verifyOperator } = require("../../src/controllers/admin/admin.index.js");
    verification.hasOperatorDocumentsForApproval.mockReturnValueOnce(false);
    User.findById.mockResolvedValueOnce({ _id: "u1", role: "operator" });
    const res = makeRes();
    const next = jest.fn();
    await verifyOperator({ params: { id: new mongoose.Types.ObjectId().toString() }, admin: { _id: "a1" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

