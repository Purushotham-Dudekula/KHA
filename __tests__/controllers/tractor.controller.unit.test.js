jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose");
  return {
    ...actual,
    Types: actual.Types,
    startSession: jest.fn(),
  };
});

jest.mock("../../src/models/tractor.model", () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({
  updateOne: jest.fn(),
}));
jest.mock("../../src/models/booking.model", () => ({}));

jest.mock("../../src/utils/verification", () => ({
  validateTractorForApproval: jest.fn(() => ({ ok: true, missing: [] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((_res, status, _msg, data) => _res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/services/storage.service", () => ({
  resolveDocumentInput: jest.fn(async (x) => `resolved:${String(x)}`),
}));
jest.mock("../../src/services/adminAuditLog.service", () => ({
  logAdminAction: jest.fn(),
}));

const mongoose = require("mongoose");
const Tractor = require("../../src/models/tractor.model");
const User = require("../../src/models/user.model");

describe("tractor.controller (unit)", () => {
  function makeRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("getTractorById -> 400 invalid id", async () => {
    const { getTractorById } = require("../../src/controllers/tractor.controller");
    const req = { params: { id: "bad" }, user: { _id: "u1", role: "operator" } };
    const res = makeRes();
    const next = jest.fn();
    await getTractorById(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("getTractorById -> 404 not found", async () => {
    const { getTractorById } = require("../../src/controllers/tractor.controller");
    const id = new mongoose.Types.ObjectId().toString();
    Tractor.findOne.mockReturnValueOnce({ populate: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValueOnce(null) });
    const req = { params: { id }, user: { _id: "u1", role: "operator" } };
    const res = makeRes();
    const next = jest.fn();
    await getTractorById(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("getTractorById -> 401 when not owning operator", async () => {
    const { getTractorById } = require("../../src/controllers/tractor.controller");
    const id = new mongoose.Types.ObjectId().toString();
    Tractor.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValueOnce({ _id: id, operatorId: { _id: "owner" } }),
    });
    const req = { params: { id }, user: { _id: "u2", role: "operator" } };
    const res = makeRes();
    const next = jest.fn();
    await getTractorById(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createTractor -> 403 for non-operator", async () => {
    const { createTractor } = require("../../src/controllers/tractor.controller");
    const res = makeRes();
    const next = jest.fn();
    await createTractor({ user: { _id: "u1", role: "farmer" }, body: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createTractor -> 400 validation required fields", async () => {
    const { createTractor } = require("../../src/controllers/tractor.controller");
    const res = makeRes();
    const next = jest.fn();
    await createTractor(
      { user: { _id: "u1", role: "operator" }, body: { brand: "b", model: "m", registrationNumber: "r", machineryTypes: [] } },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createTractor -> 201 success (transaction)", async () => {
    const { createTractor } = require("../../src/controllers/tractor.controller");
    const session = { withTransaction: jest.fn(async (fn) => fn()), endSession: jest.fn(async () => {}) };
    mongoose.startSession.mockResolvedValueOnce(session);
    Tractor.create.mockResolvedValueOnce([{ _id: "t1" }]);
    User.updateOne.mockResolvedValueOnce({ acknowledged: true });

    const req = {
      user: { _id: "u1", role: "operator" },
      body: {
        tractorType: "medium",
        brand: "B",
        model: "M",
        registrationNumber: "REG-1",
        machineryTypes: ["svc"],
      },
    };
    const res = makeRes();
    const next = jest.fn();
    await createTractor(req, res, next);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  test("createTractor -> 400 duplicate registration (11000)", async () => {
    const { createTractor } = require("../../src/controllers/tractor.controller");
    const session = { withTransaction: jest.fn(async (fn) => fn()), endSession: jest.fn(async () => {}) };
    mongoose.startSession.mockResolvedValueOnce(session);
    const err = new Error("dup");
    err.code = 11000;
    Tractor.create.mockRejectedValueOnce(err);

    const req = {
      user: { _id: "u1", role: "operator" },
      body: { tractorType: "medium", brand: "B", model: "M", registrationNumber: "REG-1", machineryTypes: ["svc"] },
    };
    const res = makeRes();
    const next = jest.fn();
    await createTractor(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("adminDeleteTractor -> 404 when not found", async () => {
    const { adminDeleteTractor } = require("../../src/controllers/tractor.controller");
    Tractor.findByIdAndDelete.mockResolvedValueOnce(null);
    const id = new mongoose.Types.ObjectId().toString();
    const req = { params: { id }, admin: { _id: "a1" } };
    const res = makeRes();
    const next = jest.fn();
    await adminDeleteTractor(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

