const mongoose = require("mongoose");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function oid(v = "507f191e810c19729de860ea") {
  return new mongoose.Types.ObjectId(v);
}

describe("admin.controller ultra coverage", () => {
  let ctrl;

  beforeAll(() => {
    ctrl = require("../../src/controllers/admin/admin.index.js");
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("validation failures: invalid/missing ids across handlers", async () => {
    const next = jest.fn();
    const reqBase = { admin: { _id: oid() }, params: { id: "bad-id" }, body: {}, query: {} };
    await ctrl.deactivateAdmin(reqBase, makeRes(), next);
    await ctrl.verifyOperator(reqBase, makeRes(), next);
    await ctrl.rejectOperator(reqBase, makeRes(), next);
    await ctrl.verifyTractor(reqBase, makeRes(), next);
    await ctrl.rejectTractor(reqBase, makeRes(), next);
    await ctrl.blockUser(reqBase, makeRes(), next);
    await ctrl.respondComplaint(reqBase, makeRes(), next);
    await ctrl.deleteSeasonalPricing(reqBase, makeRes(), next);
    await ctrl.getSecureTractorDocument(reqBase, makeRes(), next);
    await ctrl.getSecureOperatorDocument(reqBase, makeRes(), next);
    await ctrl.verifyTractorDocument(reqBase, makeRes(), next);
    await ctrl.verifyOperatorDocuments(reqBase, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test("createAdmin and bootstrapSuperAdmin validation failures", async () => {
    const next = jest.fn();
    await ctrl.createAdmin({ body: {}, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.bootstrapSuperAdmin({ body: {} }, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("demand analytics invalid dates hit 400 branches", async () => {
    const next = jest.fn();
    const res = makeRes();
    await ctrl.getAdminDemandAnalytics({ query: { startDate: "invalid" }, admin: { _id: oid() } }, res, next);
    await ctrl.getAdminDemandAnalytics({ query: { endDate: "invalid" }, admin: { _id: oid() } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("upsertCommission validation failures", async () => {
    const next = jest.fn();
    await ctrl.upsertCommission({ body: {}, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.upsertCommission({ body: { percentage: -2 }, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.upsertCommission({ body: { percentage: 10, active: "bad" }, admin: { _id: oid() } }, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  test("upsertSeasonalPricing and pricing validation failures", async () => {
    const next = jest.fn();
    await ctrl.upsertPricing({ body: {}, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.upsertSeasonalPricing({ body: {}, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.upsertSeasonalPricing(
      {
        body: {
          serviceType: "x",
          multiplier: 0,
          startDate: "bad",
          endDate: "bad",
        },
        admin: { _id: oid() },
      },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledTimes(3);
  });

  test("list and analytics handlers execute empty/invalid edge paths", async () => {
    const next = jest.fn();
    const res = makeRes();
    const req = { admin: { _id: oid() }, query: { startDate: "bad", endDate: "bad" }, params: {}, body: {} };
    await ctrl.listAdmins({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.listUsers({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.listBookings({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.getLiveBookings(req, res, next);
    await ctrl.listPendingTractors({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.listComplaints({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.listAdminAuditLogs({ ...req, query: { page: "1", limit: "0" } }, res, next);
    await ctrl.getAdminDashboard(req, res, next);
    await ctrl.getAdminRevenueAnalytics(req, res, next);
    await ctrl.getAdminDemandAnalytics(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
