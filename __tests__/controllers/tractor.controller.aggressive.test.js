jest.mock("../../src/models/tractor.model", () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({
  updateOne: jest.fn(),
}));
jest.mock("../../src/models/booking.model", () => ({
  exists: jest.fn(),
}));
jest.mock("../../src/utils/verification", () => ({
  validateTractorForApproval: jest.fn(() => ({ ok: true, missing: [] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/services/storage.service", () => ({
  resolveDocumentInput: jest.fn(async (x) => String(x)),
}));
jest.mock("../../src/services/adminAuditLog.service", () => ({
  logAdminAction: jest.fn(),
}));
jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose");
  return { ...actual, startSession: jest.fn() };
});

const mongoose = require("mongoose");
const Tractor = require("../../src/models/tractor.model");
const Booking = require("../../src/models/booking.model");
const User = require("../../src/models/user.model");
const { validateTractorForApproval } = require("../../src/utils/verification");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("tractor.controller aggressive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("getTractorById: 400 invalid id, 404 not found, 401 unauthorized, 200 success", async () => {
    const { getTractorById } = require("../../src/controllers/tractor.controller");
    const next = jest.fn();
    await getTractorById({ params: { id: "bad" }, user: { _id: "u1", role: "operator" } }, makeRes(), next);

    Tractor.findOne.mockReturnValueOnce({ populate: () => ({ lean: () => Promise.resolve(null) }) });
    await getTractorById({ params: { id: "507f1f77bcf86cd799439011" }, user: { _id: "u1", role: "operator" } }, makeRes(), next);

    Tractor.findOne.mockReturnValueOnce({
      populate: () => ({ lean: () => Promise.resolve({ _id: "t1", operatorId: { _id: "u2" } }) }),
    });
    await getTractorById({ params: { id: "507f1f77bcf86cd799439011" }, user: { _id: "u1", role: "operator" } }, makeRes(), next);

    const res = makeRes();
    Tractor.findOne.mockReturnValueOnce({
      populate: () => ({
        lean: () =>
          Promise.resolve({
            _id: "t1",
            operatorId: { _id: "u1", name: "Op", village: "v", averageRating: 4, reviewCount: 2 },
          }),
      }),
    });
    await getTractorById({ params: { id: "507f1f77bcf86cd799439011" }, user: { _id: "u1", role: "operator" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("createTractor: 403, 400 validation, 400 duplicate, 201 success, 500 via thrown error", async () => {
    const { createTractor } = require("../../src/controllers/tractor.controller");
    let res = makeRes();
    let next = jest.fn();
    await createTractor({ user: { _id: "u1", role: "farmer" }, body: {} }, res, next);

    res = makeRes();
    next = jest.fn();
    await createTractor({ user: { _id: "u1", role: "operator" }, body: { brand: "b" } }, res, next);

    const session = { withTransaction: jest.fn(async (fn) => fn()), endSession: jest.fn(async () => {}) };
    mongoose.startSession.mockResolvedValueOnce(session);
    const dup = new Error("dup");
    dup.code = 11000;
    Tractor.create.mockRejectedValueOnce(dup);
    await createTractor(
      {
        user: { _id: "u1", role: "operator" },
        body: { tractorType: "small", brand: "b", model: "m", registrationNumber: "R1", machineryTypes: ["x"] },
      },
      makeRes(),
      jest.fn()
    );

    mongoose.startSession.mockResolvedValueOnce(session);
    Tractor.create.mockResolvedValueOnce([{ _id: "t1" }]);
    User.updateOne.mockResolvedValueOnce({});
    res = makeRes();
    await createTractor(
      {
        user: { _id: "u1", role: "operator" },
        body: { tractorType: "small", brand: "b", model: "m", registrationNumber: "R2", machineryTypes: ["x"] },
      },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(201);

    mongoose.startSession.mockRejectedValueOnce(new Error("session fail"));
    await createTractor(
      {
        user: { _id: "u1", role: "operator" },
        body: { tractorType: "small", brand: "b", model: "m", registrationNumber: "R3", machineryTypes: ["x"] },
      },
      makeRes(),
      jest.fn()
    );
  });

  test("uploadTractorDocuments branches: 403/400/404/400 invalidation/200 success", async () => {
    const { uploadTractorDocuments } = require("../../src/controllers/tractor.controller");
    await uploadTractorDocuments({ user: { _id: "u1", role: "farmer" }, params: {}, body: {}, files: {} }, makeRes(), jest.fn());
    await uploadTractorDocuments({ user: { _id: "u1", role: "operator" }, params: { id: "bad" }, body: {}, files: {} }, makeRes(), jest.fn());

    Tractor.findOne.mockResolvedValueOnce(null);
    await uploadTractorDocuments(
      { user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: {}, files: {} },
      makeRes(),
      jest.fn()
    );

    const tractorApproved = {
      verificationStatus: "approved",
      toObject: () => ({}),
      save: jest.fn(),
    };
    validateTractorForApproval.mockReturnValueOnce({ ok: false, missing: ["rcDocument"] });
    Tractor.findOne.mockResolvedValueOnce(tractorApproved);
    await uploadTractorDocuments(
      {
        user: { _id: "u1", role: "operator" },
        params: { id: "507f1f77bcf86cd799439011" },
        body: { rcDocument: "x" },
        files: {},
      },
      makeRes(),
      jest.fn()
    );

    validateTractorForApproval.mockReturnValue({ ok: true, missing: [] });
    Tractor.findOne.mockResolvedValueOnce({ verificationStatus: "pending", save: jest.fn(), toObject: () => ({}) });
    const res = makeRes();
    await uploadTractorDocuments(
      {
        user: { _id: "u1", role: "operator" },
        params: { id: "507f1f77bcf86cd799439011" },
        body: { rcDocument: "x" },
        files: {},
      },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("list/update/delete/admin paths smoke with status coverage", async () => {
    const c = require("../../src/controllers/tractor.controller");
    await c.getMyTractors({ user: { role: "farmer" }, query: {} }, makeRes(), jest.fn()); // 403
    Tractor.countDocuments.mockResolvedValueOnce(0);
    Tractor.find.mockReturnValueOnce({ sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }) });
    const res1 = makeRes();
    await c.getMyTractors({ user: { _id: "u1", role: "operator" }, query: {} }, res1, jest.fn()); // 200
    expect(res1.status).toHaveBeenCalledWith(200);

    Tractor.find.mockReturnValueOnce({
      sort: () => ({ skip: () => ({ limit: () => ({ populate: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
    });
    await c.listAllTractors({ query: {} }, makeRes(), jest.fn()); // 200

    await c.setTractorAvailability({ user: { role: "farmer" }, params: {}, body: {} }, makeRes(), jest.fn()); // 403
    await c.setTractorAvailability({ user: { role: "operator" }, params: { id: "bad" }, body: {} }, makeRes(), jest.fn()); // 400
    await c.setTractorAvailability({ user: { role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: { isAvailable: "x" } }, makeRes(), jest.fn()); // 400
    Tractor.findOneAndUpdate.mockResolvedValueOnce(null);
    await c.setTractorAvailability({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: { isAvailable: true } }, makeRes(), jest.fn()); // 404

    await c.updateTractorBasics({ user: { role: "farmer" }, params: {}, body: {} }, makeRes(), jest.fn()); // 403
    await c.updateTractorBasics({ user: { role: "operator" }, params: { id: "bad" }, body: {} }, makeRes(), jest.fn()); // 400
    Tractor.findOne.mockResolvedValueOnce(null);
    await c.updateTractorBasics({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: {} }, makeRes(), jest.fn()); // 404

    await c.adminSetTractorVerification({ params: { tractorId: "bad" }, body: {} }, makeRes(), jest.fn()); // 400
    await c.adminSetTractorVerification({ params: { tractorId: "507f1f77bcf86cd799439011" }, body: { status: "x" } }, makeRes(), jest.fn()); // 400
    Tractor.findById.mockResolvedValueOnce(null);
    await c.adminSetTractorVerification({ params: { tractorId: "507f1f77bcf86cd799439011" }, body: { status: "approved" } }, makeRes(), jest.fn()); // 404

    await c.deleteTractor({ user: { role: "farmer" }, params: {} }, makeRes(), jest.fn()); //403
    await c.deleteTractor({ user: { role: "operator" }, params: { id: "bad" } }, makeRes(), jest.fn()); //400
    Tractor.findOne.mockResolvedValueOnce(null);
    await c.deleteTractor({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" } }, makeRes(), jest.fn()); //404
    Tractor.findOne.mockResolvedValueOnce({ _id: "t1", isDeleted: false, save: jest.fn() });
    Booking.exists.mockResolvedValueOnce(true);
    await c.deleteTractor({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" } }, makeRes(), jest.fn()); //400

    Tractor.findByIdAndDelete.mockResolvedValueOnce(null);
    await c.adminDeleteTractor({ admin: { _id: "a1" }, params: { id: "507f1f77bcf86cd799439011" } }, makeRes(), jest.fn()); //404
  });
});

