jest.mock("../../src/models/tractor.model", () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
}));
jest.mock("../../src/models/booking.model", () => ({
  exists: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({}));
jest.mock("../../src/services/storage.service", () => ({ resolveDocumentInput: jest.fn(async (x) => String(x)) }));
jest.mock("../../src/services/adminAuditLog.service", () => ({ logAdminAction: jest.fn() }));
jest.mock("../../src/utils/verification", () => ({
  validateTractorForApproval: jest.fn(() => ({ ok: false, missing: ["rcDocument"] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));

const Tractor = require("../../src/models/tractor.model");
const Booking = require("../../src/models/booking.model");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("tractor.controller (more coverage unit)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("getMyTractors -> 403 when not operator", async () => {
    const { getMyTractors } = require("../../src/controllers/tractor.controller");
    const res = makeRes();
    const next = jest.fn();
    await getMyTractors({ user: { _id: "u1", role: "farmer" }, query: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("getMyTractors -> 200 success", async () => {
    const { getMyTractors } = require("../../src/controllers/tractor.controller");
    Tractor.countDocuments.mockResolvedValueOnce(1);
    Tractor.find.mockReturnValueOnce({ sort: () => ({ skip: () => ({ limit: () => Promise.resolve([{ _id: "t1" }]) }) }) });
    const res = makeRes();
    const next = jest.fn();
    await getMyTractors({ user: { _id: "u1", role: "operator" }, query: { page: "1", limit: "10" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("listAllTractors -> 200 success", async () => {
    const { listAllTractors } = require("../../src/controllers/tractor.controller");
    Tractor.find.mockReturnValueOnce({
      sort: () => ({ skip: () => ({ limit: () => ({ populate: () => ({ lean: () => Promise.resolve([{ _id: "t1" }]) }) }) }) }),
    });
    const res = makeRes();
    const next = jest.fn();
    await listAllTractors({ query: { page: "1", limit: "10" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("setTractorAvailability -> 400 invalid isAvailable type", async () => {
    const { setTractorAvailability } = require("../../src/controllers/tractor.controller");
    const res = makeRes();
    const next = jest.fn();
    await setTractorAvailability({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: { isAvailable: "yes" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("setTractorAvailability -> 404 not found", async () => {
    const { setTractorAvailability } = require("../../src/controllers/tractor.controller");
    Tractor.findOneAndUpdate.mockResolvedValueOnce(null);
    const res = makeRes();
    const next = jest.fn();
    await setTractorAvailability({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: { isAvailable: true } }, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("updateTractorBasics -> 400 no updates", async () => {
    const { updateTractorBasics } = require("../../src/controllers/tractor.controller");
    Tractor.findOne.mockResolvedValueOnce({ save: jest.fn() });
    const res = makeRes();
    const next = jest.fn();
    await updateTractorBasics({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" }, body: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("deleteTractor -> 400 when active bookings exist", async () => {
    const { deleteTractor } = require("../../src/controllers/tractor.controller");
    Tractor.findOne.mockResolvedValueOnce({ _id: "t1", isDeleted: false, save: jest.fn() });
    Booking.exists.mockResolvedValueOnce(true);
    const res = makeRes();
    const next = jest.fn();
    await deleteTractor({ user: { _id: "u1", role: "operator" }, params: { id: "507f1f77bcf86cd799439011" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

