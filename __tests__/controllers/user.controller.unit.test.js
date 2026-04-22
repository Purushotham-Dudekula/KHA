jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock("../../src/models/booking.model", () => ({
  find: jest.fn(),
}));
jest.mock("../../src/models/tractor.model", () => ({
  find: jest.fn(),
}));
jest.mock("../../src/models/pricing.model", () => ({
  findOne: jest.fn(),
}));
jest.mock("../../src/models/notification.model", () => ({
  countDocuments: jest.fn(),
}));

jest.mock("../../src/services/user.service", () => ({
  findNearbyOperators: jest.fn(),
}));
jest.mock("../../src/services/serviceCache.service", () => ({
  getServiceByCodeCached: jest.fn(),
}));
jest.mock("../../src/services/storage.service", () => ({
  resolveDocumentInput: jest.fn(),
}));
jest.mock("../../src/services/operatorStats.service", () => ({
  getOperatorReliabilityMetrics: jest.fn(),
}));
jest.mock("../../src/services/cache.service", () => ({
  getCachedJson: jest.fn(),
  setCachedJson: jest.fn(),
}));

jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((_res, status, _msg, data) => {
    _res.status(status).json({ success: true, data });
  }),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({
  cleanUserResponse: jest.fn((u) => u),
}));
jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const User = require("../../src/models/user.model");
const Booking = require("../../src/models/booking.model");
const Notification = require("../../src/models/notification.model");
const Pricing = require("../../src/models/pricing.model");
const { findNearbyOperators } = require("../../src/services/user.service");
const { resolveDocumentInput } = require("../../src/services/storage.service");
const { getCachedJson } = require("../../src/services/cache.service");
const { getServiceByCodeCached } = require("../../src/services/serviceCache.service");
const { sendSuccess } = require("../../src/utils/apiResponse");

describe("user.controller (unit)", () => {
  function makeRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("getMe -> 404 when user missing", async () => {
    const { getMe } = require("../../src/controllers/user.controller");
    User.findById.mockReturnValueOnce({ select: jest.fn().mockResolvedValueOnce(null) });

    const req = { user: { _id: "u1" } };
    const res = makeRes();
    const next = jest.fn();
    await getMe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("getMe -> 500 forwards DB error", async () => {
    const { getMe } = require("../../src/controllers/user.controller");
    const err = new Error("db down");
    User.findById.mockReturnValueOnce({ select: jest.fn().mockRejectedValueOnce(err) });

    const next = jest.fn();
    await getMe({ user: { _id: "u1" } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });

  test("selectRole -> 400 when role missing", async () => {
    const { selectRole } = require("../../src/controllers/user.controller");
    const req = { user: { _id: "u1" }, body: {} };
    const res = makeRes();
    const next = jest.fn();
    await selectRole(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("selectRole -> 400 when role invalid", async () => {
    const { selectRole } = require("../../src/controllers/user.controller");
    const req = { user: { _id: "u1" }, body: { role: "bad" } };
    const res = makeRes();
    const next = jest.fn();
    await selectRole(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("selectRole -> 200 success path", async () => {
    const { selectRole } = require("../../src/controllers/user.controller");
    User.findByIdAndUpdate.mockReturnValueOnce({ select: jest.fn().mockResolvedValueOnce({ _id: "u1" }) });

    const req = { user: { _id: "u1" }, body: { role: "farmer" } };
    const res = makeRes();
    const next = jest.fn();
    await selectRole(req, res, next);

    expect(sendSuccess).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("updateFarmerProfile -> 403 for non-farmer", async () => {
    const { updateFarmerProfile } = require("../../src/controllers/user.controller");
    const req = { user: { _id: "u1", role: "operator" }, body: { name: "n" } };
    const res = makeRes();
    const next = jest.fn();
    await updateFarmerProfile(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("updateFarmerProfile -> 400 when operator-only field included", async () => {
    const { updateFarmerProfile } = require("../../src/controllers/user.controller");
    const req = {
      user: { _id: "u1", role: "farmer" },
      body: { name: "n", village: "v", mandal: "m", district: "d", state: "s", pincode: "1", landArea: 1, tractorType: "small" },
    };
    const res = makeRes();
    const next = jest.fn();
    await updateFarmerProfile(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("updateLocation -> 400 invalid numbers", async () => {
    const { updateLocation } = require("../../src/controllers/user.controller");
    const res = makeRes();
    const next = jest.fn();
    await updateLocation({ user: { _id: "u1" }, body: { latitude: "x", longitude: "y" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("updateStatus -> 400 when isOnline not boolean", async () => {
    const { updateStatus } = require("../../src/controllers/user.controller");
    const res = makeRes();
    const next = jest.fn();
    await updateStatus({ user: { _id: "u1" }, body: { isOnline: "yes" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("getFarmerDashboard -> 200 even if one query fails (allSettled fallback)", async () => {
    const { getFarmerDashboard } = require("../../src/controllers/user.controller");
    Booking.find
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([{ _id: "b1" }]) }) }) }) }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.reject(new Error("db down")) }) }) }) }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([]) }) }) }) }) });
    Notification.countDocuments.mockRejectedValueOnce(new Error("count fail"));

    const req = { user: { _id: "u1", role: "farmer" } };
    const res = makeRes();
    const next = jest.fn();
    await getFarmerDashboard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          activeBookings: expect.any(Array),
          pendingPayments: [],
          recentBookings: expect.any(Array),
          notificationsCount: 0,
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test("updateLanguage -> 404 when user not found", async () => {
    const { updateLanguage } = require("../../src/controllers/user.controller");
    User.findByIdAndUpdate.mockReturnValueOnce({ select: jest.fn().mockResolvedValueOnce(null) });
    const res = makeRes();
    const next = jest.fn();
    await updateLanguage({ user: { _id: "u1" }, body: { language: "en" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("updateFcmToken -> 200 success", async () => {
    const { updateFcmToken } = require("../../src/controllers/user.controller");
    User.findByIdAndUpdate.mockReturnValueOnce({ select: jest.fn().mockResolvedValueOnce({ _id: "u1" }) });
    const res = makeRes();
    const next = jest.fn();
    await updateFcmToken({ user: { _id: "u1" }, body: { fcmToken: " tok " } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("uploadOperatorDocuments -> 200 success and rejected->pending reset", async () => {
    const { uploadOperatorDocuments } = require("../../src/controllers/user.controller");
    resolveDocumentInput.mockResolvedValueOnce("aadhaar-url").mockResolvedValueOnce("dl-url");

    const userDoc = {
      _id: "u1",
      verificationStatus: "rejected",
      save: jest.fn(async () => {}),
    };
    User.findById.mockResolvedValueOnce(userDoc);
    User.findById.mockReturnValueOnce({ select: jest.fn().mockResolvedValueOnce({ _id: "u1" }) });

    const res = makeRes();
    const next = jest.fn();
    await uploadOperatorDocuments(
      {
        user: { _id: "u1", role: "operator" },
        files: {},
        body: { aadhaarDocument: "a", drivingLicenseDocument: "b" },
      },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(userDoc.verificationStatus).toBe("pending");
    expect(next).not.toHaveBeenCalled();
  });

  test("getNearbyOperators -> 200 filters tractors by serviceType/type and approved+available", async () => {
    const { getNearbyOperators } = require("../../src/controllers/user.controller");
    findNearbyOperators.mockResolvedValueOnce({
      onlineOperators: [
        {
          _id: "op1",
          name: "O",
          village: "V",
          isOnline: true,
          distance: 123,
          tractors: [{ _id: "t1", verificationStatus: "approved", isAvailable: true, machineryTypes: ["svc1"], machinerySubTypes: ["sub1"] }],
        },
      ],
      offlineOperators: [],
    });
    Pricing.findOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ serviceType: "svc1", pricePerAcre: 10, pricePerHour: 0 }) }) });
    getServiceByCodeCached.mockResolvedValueOnce({ code: "svc1", types: [{ name: "sub1", pricePerAcre: 99 }] });

    const res = makeRes();
    const next = jest.fn();
    await getNearbyOperators(
      { query: { lat: "1", lng: "2", radius: "3", serviceType: "SVC1", type: "SUB1" }, user: { _id: "u1" } },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("getFarmerDashboard -> returns cached payload when present", async () => {
    const { getFarmerDashboard } = require("../../src/controllers/user.controller");
    getCachedJson.mockResolvedValueOnce({ activeBookings: [], pendingPayments: [], recentBookings: [], notificationsCount: 5 });
    const res = makeRes();
    const next = jest.fn();
    await getFarmerDashboard({ user: { _id: "u1", role: "farmer" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });
});

