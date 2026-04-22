const mongoose = require("mongoose");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
}

function oid(id = "507f191e810c19729de860ea") {
  return new mongoose.Types.ObjectId(id);
}

describe("booking.controller validation/auth branch coverage", () => {
  let bookingController;

  beforeAll(() => {
    bookingController = require("../../src/controllers/booking/booking.index.js");
  });

  test("respondToBooking: wrong role -> 403", async () => {
    const req = { user: { role: "farmer" }, params: { id: String(oid()) }, body: { action: "accept" } };
    const res = makeRes();
    const next = jest.fn();
    await bookingController.respondToBooking(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
  });

  test("respondToBooking: invalid id -> 400", async () => {
    const req = { user: { role: "operator" }, params: { id: "bad" }, body: { action: "accept" } };
    const res = makeRes();
    const next = jest.fn();
    await bookingController.respondToBooking(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalled();
  });

  test("respondToBooking: missing action -> 400", async () => {
    const req = { user: { role: "operator" }, params: { id: String(oid()) }, body: {} };
    const res = makeRes();
    const next = jest.fn();
    await bookingController.respondToBooking(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalled();
  });

  test("payAdvance wrong role -> 403", async () => {
    const req = { user: { role: "operator", _id: oid() }, params: { id: String(oid()) }, body: {} };
    const res = makeRes();
    const next = jest.fn();
    await bookingController.payAdvance(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
  });

  test("payRemaining wrong role -> 403", async () => {
    const req = { user: { role: "operator", _id: oid() }, params: { id: String(oid()) }, body: {} };
    const res = makeRes();
    const next = jest.fn();
    await bookingController.payRemaining(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
  });
});

describe("review.controller branch coverage", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("wrong role/invalid id/rating and not found paths", async () => {
    const bookingFindById = jest.fn().mockResolvedValue(null);
    jest.doMock("../../src/models/booking.model", () => ({ findById: bookingFindById }));
    jest.doMock("../../src/models/review.model", () => ({ create: jest.fn() }));
    jest.doMock("../../src/services/operatorStats.service", () => ({ syncOperatorRatingFromReviews: jest.fn() }));
    const { submitReview } = require("../../src/controllers/review.controller");

    const res = makeRes();
    const next = jest.fn();

    await submitReview(
      { user: { role: "operator", _id: oid() }, params: { id: String(oid()) }, body: { rating: 5 } },
      res,
      next
    );
    await submitReview(
      { user: { role: "farmer", _id: oid() }, params: { id: "bad-id" }, body: { rating: 5 } },
      res,
      next
    );
    await submitReview(
      { user: { role: "farmer", _id: oid() }, params: { id: String(oid()) }, body: { rating: 9 } },
      res,
      next
    );
    await submitReview(
      { user: { role: "farmer", _id: oid() }, params: { id: String(oid()) }, body: { rating: 4 } },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(4);
  });

  test("duplicate review path -> 409", async () => {
    const farmerId = oid("507f191e810c19729de860eb");
    const bookingDoc = {
      _id: oid("507f191e810c19729de860ec"),
      farmer: { equals: (x) => String(x) === String(farmerId) },
      operator: oid("507f191e810c19729de860ed"),
      status: "completed",
    };
    const create = jest.fn().mockRejectedValue({ code: 11000 });
    jest.doMock("../../src/models/booking.model", () => ({ findById: jest.fn().mockResolvedValue(bookingDoc) }));
    jest.doMock("../../src/models/review.model", () => ({ create }));
    jest.doMock("../../src/services/operatorStats.service", () => ({ syncOperatorRatingFromReviews: jest.fn() }));
    const { submitReview } = require("../../src/controllers/review.controller");
    const next = jest.fn();
    await submitReview(
      { user: { role: "farmer", _id: farmerId }, params: { id: String(bookingDoc._id) }, body: { rating: 5 } },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
  });
});

describe("operator.controller branch coverage", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("update bank details wrong role and not found", async () => {
    const findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    jest.doMock("../../src/models/user.model", () => ({ findByIdAndUpdate }));
    jest.doMock("../../src/models/payment.model", () => ({}));
    jest.doMock("../../src/models/booking.model", () => ({}));
    jest.doMock("../../src/models/operatorEarning.model", () => ({ find: jest.fn() }));
    const ctrl = require("../../src/controllers/operator.controller");
    const next = jest.fn();

    await ctrl.updateOperatorBankDetails(
      { user: { role: "farmer", _id: oid() }, body: {} },
      makeRes(),
      next
    );
    await ctrl.updateOperatorBankDetails(
      { user: { role: "operator", _id: oid() }, body: { accountNumber: "1", ifsc: "x" } },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("location/history/earnings auth and validation failures", async () => {
    jest.doMock("../../src/models/user.model", () => ({ findByIdAndUpdate: jest.fn().mockResolvedValue({}) }));
    jest.doMock("../../src/models/payment.model", () => ({}));
    jest.doMock("../../src/models/booking.model", () => ({ countDocuments: jest.fn(), find: jest.fn() }));
    jest.doMock("../../src/models/operatorEarning.model", () => ({ find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: jest.fn() }) }) }) })) }));
    const ctrl = require("../../src/controllers/operator.controller");
    const next = jest.fn();

    await ctrl.getOperatorEarnings({ user: { role: "farmer", _id: oid() }, query: {} }, makeRes(), next);
    await ctrl.updateOperatorLocation(
      { user: { role: "operator", _id: oid() }, body: { latitude: "500", longitude: "80" } },
      makeRes(),
      next
    );
    await ctrl.getOperatorEarningsHistory({ user: { role: "farmer", _id: oid() }, query: {} }, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});

describe("admin.controller branch coverage", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("createAdmin validation + duplicate", async () => {
    const exists = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    jest.doMock("../../src/models/admin.model", () => ({
      exists,
      create: jest.fn().mockResolvedValue({
        _id: oid(),
        role: "admin",
        isActive: true,
        toObject: () => ({ _id: oid(), name: "n", email: "e", role: "admin", isActive: true }),
      }),
    }));
    jest.doMock("../../src/models/user.model", () => ({}));
    jest.doMock("../../src/models/tractor.model", () => ({}));
    jest.doMock("../../src/models/booking.model", () => ({}));
    jest.doMock("../../src/models/complaint.model", () => ({}));
    jest.doMock("../../src/models/payment.model", () => ({}));
    jest.doMock("../../src/models/pricing.model", () => ({}));
    jest.doMock("../../src/models/commission.model", () => ({}));
    jest.doMock("../../src/models/seasonalPricing.model", () => ({}));
    jest.doMock("../../src/models/adminAuditLog.model", () => ({}));
    jest.doMock("../../src/models/adminActivityLog.model", () => ({}));
    jest.doMock("../../src/services/adminAuditLog.service", () => ({ logAdminAction: jest.fn() }));
    jest.doMock("../../src/utils/verification", () => ({
      hasOperatorDocumentsForApproval: jest.fn(),
      validateTractorForApproval: jest.fn(),
      deriveTractorVerificationFromDocuments: jest.fn(),
    }));
    jest.doMock("../../src/utils/cleanUserResponse", () => ({ cleanUserResponse: jest.fn((x) => x) }));
    jest.doMock("../../src/services/notification.service", () => ({ notifyUser: jest.fn() }));
    jest.doMock("../../src/services/payment.service", () => ({ refundUpiPayment: jest.fn() }));
    jest.doMock("../../src/services/ledger.service", () => ({ logRefundSuccess: jest.fn() }));
    jest.doMock("../../src/utils/refundCalculation", () => ({ resolveRefundSnapshot: jest.fn() }));
    jest.doMock("../../src/services/storage.service", () => ({ getSecureFileUrl: jest.fn() }));
    jest.doMock("../../src/services/adminActivityLog.service", () => ({ logAdminActivity: jest.fn() }));
    jest.doMock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));
    jest.doMock("../../src/middleware/auth.middleware", () => ({ invalidateUserAuthCache: jest.fn() }));
    const ctrl = require("../../src/controllers/admin/admin.index.js");
    const next = jest.fn();

    await ctrl.createAdmin({ body: { email: "a@x.com" }, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.createAdmin({ body: { name: "x", email: "a@x.com" }, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.createAdmin({ body: { name: "x", email: "a@x.com" }, admin: { _id: oid() } }, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("bootstrap/deactivate/verifyOperator validation failures", async () => {
    jest.doMock("../../src/models/admin.model", () => ({
      exists: jest.fn().mockResolvedValue(true),
      findById: jest.fn(),
    }));
    jest.doMock("../../src/models/user.model", () => ({ findById: jest.fn() }));
    jest.doMock("../../src/models/tractor.model", () => ({}));
    jest.doMock("../../src/models/booking.model", () => ({}));
    jest.doMock("../../src/models/complaint.model", () => ({}));
    jest.doMock("../../src/models/payment.model", () => ({}));
    jest.doMock("../../src/models/pricing.model", () => ({}));
    jest.doMock("../../src/models/commission.model", () => ({}));
    jest.doMock("../../src/models/seasonalPricing.model", () => ({}));
    jest.doMock("../../src/models/adminAuditLog.model", () => ({}));
    jest.doMock("../../src/models/adminActivityLog.model", () => ({}));
    jest.doMock("../../src/services/adminAuditLog.service", () => ({ logAdminAction: jest.fn() }));
    jest.doMock("../../src/utils/verification", () => ({
      hasOperatorDocumentsForApproval: jest.fn(),
      validateTractorForApproval: jest.fn(),
      deriveTractorVerificationFromDocuments: jest.fn(),
    }));
    jest.doMock("../../src/utils/cleanUserResponse", () => ({ cleanUserResponse: jest.fn((x) => x) }));
    jest.doMock("../../src/services/notification.service", () => ({ notifyUser: jest.fn() }));
    jest.doMock("../../src/services/payment.service", () => ({ refundUpiPayment: jest.fn() }));
    jest.doMock("../../src/services/ledger.service", () => ({ logRefundSuccess: jest.fn() }));
    jest.doMock("../../src/utils/refundCalculation", () => ({ resolveRefundSnapshot: jest.fn() }));
    jest.doMock("../../src/services/storage.service", () => ({ getSecureFileUrl: jest.fn() }));
    jest.doMock("../../src/services/adminActivityLog.service", () => ({ logAdminActivity: jest.fn() }));
    jest.doMock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));
    jest.doMock("../../src/middleware/auth.middleware", () => ({ invalidateUserAuthCache: jest.fn() }));
    const ctrl = require("../../src/controllers/admin/admin.index.js");
    const next = jest.fn();

    await ctrl.bootstrapSuperAdmin({ body: {} }, makeRes(), next);
    await ctrl.deactivateAdmin({ params: { id: "bad" }, admin: { _id: oid() } }, makeRes(), next);
    await ctrl.verifyOperator({ params: { id: "bad" }, admin: { _id: oid() } }, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
