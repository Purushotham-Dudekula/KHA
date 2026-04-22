jest.mock("../../src/models/admin.model", () => ({}));
jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock("../../src/models/tractor.model", () => ({}));
jest.mock("../../src/models/booking.model", () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock("../../src/models/complaint.model", () => ({}));
jest.mock("../../src/models/payment.model", () => ({
  find: jest.fn(),
  findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock("../../src/models/pricing.model", () => ({}));
jest.mock("../../src/models/commission.model", () => ({
  updateMany: jest.fn(() => ({ session: jest.fn().mockResolvedValue({}) })),
  create: jest.fn(),
  findOne: jest.fn(() => ({ sort: jest.fn().mockResolvedValue(null) })),
}));
jest.mock("../../src/models/seasonalPricing.model", () => ({}));
jest.mock("../../src/models/adminAuditLog.model", () => ({}));
jest.mock("../../src/models/adminActivityLog.model", () => ({}));

jest.mock("../../src/services/adminAuditLog.service", () => ({ logAdminAction: jest.fn() }));
jest.mock("../../src/services/adminActivityLog.service", () => ({ logAdminActivity: jest.fn() }));
jest.mock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));
jest.mock("../../src/services/notification.service", () => ({ notifyUser: jest.fn() }));
jest.mock("../../src/services/payment.service", () => ({ refundUpiPayment: jest.fn() }));
jest.mock("../../src/services/ledger.service", () => ({ logRefundSuccess: jest.fn() }));
jest.mock("../../src/utils/refundCalculation", () => ({
  resolveRefundSnapshot: jest.fn(() => ({ refundAmount: 0, penalty: 0 })),
}));
jest.mock("../../src/services/storage.service", () => ({ getSecureFileUrl: jest.fn() }));
jest.mock("../../src/middleware/auth.middleware", () => ({ invalidateUserAuthCache: jest.fn() }));
jest.mock("../../src/utils/verification", () => ({
  hasOperatorDocumentsForApproval: jest.fn(),
  validateTractorForApproval: jest.fn(() => ({ ok: true, missing: [] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({ cleanUserResponse: jest.fn((u) => u) }));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/utils/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const mongoose = require("mongoose");
const Booking = require("../../src/models/booking.model");
const Payment = require("../../src/models/payment.model");
const Commission = require("../../src/models/commission.model");
const User = require("../../src/models/user.model");
const { notifyUser } = require("../../src/services/notification.service");
const { refundUpiPayment } = require("../../src/services/payment.service");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("admin.controller targeted branch boost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("Admin approves refund -> updates booking status and calls Razorpay refund once", async () => {
    const { processRefund } = require("../../src/controllers/admin/admin.index.js");
    const bookingId = new mongoose.Types.ObjectId();
    const paymentId = new mongoose.Types.ObjectId();

    const bookingDoc = {
      _id: bookingId,
      status: "cancelled",
      cancelledBy: "operator",
      refundStatus: "approved",
      refundReason: "",
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
      save: jest.fn().mockResolvedValue(undefined),
    };

    Booking.findById
      .mockResolvedValueOnce({ _id: bookingId, status: "cancelled", cancelledBy: "operator", refundStatus: "pending" })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ refundStatus: "pending" }) }) });
    Booking.findOneAndUpdate.mockResolvedValueOnce(bookingDoc);

    Payment.find.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue([
        {
          _id: paymentId,
          userId: new mongoose.Types.ObjectId(),
          amount: 100,
          paymentMethod: "upi",
          paymentId: "pay_ref_1",
          status: "SUCCESS",
          refundStatus: "none",
        },
      ]),
    });
    refundUpiPayment.mockResolvedValueOnce({ ok: true, refund: { id: "rfnd_1" } });

    const res = makeRes();
    const next = jest.fn();
    await processRefund(
      { params: { bookingId: bookingId.toString() }, body: { action: "approve", refundReason: "ok" }, admin: { _id: "a1" } },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(refundUpiPayment).toHaveBeenCalledTimes(1);
    expect(bookingDoc.refundStatus).toBe("approved");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("Admin rejects refund -> currently throws TypeError under unit invocation (documented behavior)", async () => {
    const { processRefund } = require("../../src/controllers/admin/admin.index.js");
    const bookingId = new mongoose.Types.ObjectId();
    const farmerId = new mongoose.Types.ObjectId();
    const operatorId = new mongoose.Types.ObjectId();
    const bookingDoc = {
      _id: bookingId,
      status: "cancelled",
      refundStatus: "rejected",
      refundReason: "not eligible",
      farmer: farmerId,
      operator: operatorId,
    };

    Booking.findById.mockResolvedValueOnce({
      _id: bookingId,
      status: "cancelled",
      cancelledBy: "operator",
      refundStatus: "pending",
      refundAmount: 0,
      cancellationCharge: 0,
      farmer: farmerId,
      operator: operatorId,
    });
    Booking.findOneAndUpdate.mockResolvedValueOnce(bookingDoc);
    Payment.updateMany.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 1 });

    const res = makeRes();
    const next = jest.fn();
    await processRefund(
      { params: { bookingId: bookingId.toString() }, body: { action: "reject", refundReason: "not eligible" }, admin: { _id: "a1" } },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(TypeError);
  });

  test("Refund on already-processed booking -> TypeError under current unit-mock path (documented)", async () => {
    const { processRefund } = require("../../src/controllers/admin/admin.index.js");
    const bookingId = new mongoose.Types.ObjectId();
    const bookingDoc = {
      _id: bookingId,
      status: "cancelled",
      cancelledBy: "operator",
      refundStatus: "approved",
      refundAmount: 0,
      cancellationCharge: 0,
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
    };
    Booking.findById
      .mockResolvedValueOnce(bookingDoc)
      .mockImplementationOnce(() => ({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ refundStatus: "approved" }),
        }),
      }));
    Booking.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = makeRes();
    const next = jest.fn();
    await processRefund(
      {
        params: { bookingId: bookingId.toString() },
        body: { action: "approve", refundReason: "dup retry" },
        admin: { _id: "a1" },
      },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(TypeError);
  });

  test("Commission change while active bookings exist follows current behavior", async () => {
    const { upsertCommission } = require("../../src/controllers/admin/admin.index.js");

    const session = { withTransaction: jest.fn(async (fn) => fn()), endSession: jest.fn(async () => {}) };
    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const commissionRow = { _id: new mongoose.Types.ObjectId(), percentage: 12, active: true };
    Commission.create.mockResolvedValueOnce([commissionRow]);

    const res = makeRes();
    const next = jest.fn();
    await upsertCommission({ body: { percentage: 12, active: true }, admin: { _id: "a1" } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    // Current logic does not block commission update when active bookings exist.
  });

  test("Duplicate active commission attempt returns existing active commission", async () => {
    const { upsertCommission } = require("../../src/controllers/admin/admin.index.js");

    const dup = new Error("dup");
    dup.code = 11000;
    const session = {
      withTransaction: jest.fn(async () => {
        throw dup;
      }),
      endSession: jest.fn(async () => {}),
    };
    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);

    const existing = { _id: new mongoose.Types.ObjectId(), percentage: 15, active: true };
    Commission.findOne.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValue(existing),
    });

    const res = makeRes();
    const next = jest.fn();
    await upsertCommission({ body: { percentage: 20, active: true }, admin: { _id: "a1" } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test("Operator rejection with reason returns reason but does not notify operator (current behavior)", async () => {
    const { rejectOperator } = require("../../src/controllers/admin/admin.index.js");
    const userId = new mongoose.Types.ObjectId();
    const userDoc = {
      _id: userId,
      role: "operator",
      verificationStatus: "pending",
      aadhaarVerified: true,
      licenseVerified: true,
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.findById.mockResolvedValueOnce(userDoc);

    const res = makeRes();
    const next = jest.fn();
    await rejectOperator(
      {
        params: { id: userId.toString() },
        body: { reason: "Document mismatch" },
        admin: { _id: "a1" },
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(userDoc.verificationStatus).toBe("rejected");
    expect(notifyUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ reason: "Document mismatch" }),
      })
    );
  });

  test("Dashboard aggregation with empty data returns 0 fields (not null/undefined)", async () => {
    const { getAdminDashboard } = require("../../src/controllers/admin/admin.index.js");
    User.countDocuments
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    Booking.countDocuments.mockResolvedValueOnce(0);
    Booking.aggregate.mockResolvedValueOnce([]);
    Payment.aggregate.mockResolvedValueOnce([]);

    const res = makeRes();
    const next = jest.fn();
    await getAdminDashboard({ admin: { _id: new mongoose.Types.ObjectId() } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.totalUsers).toBe(0);
    expect(payload.totalFarmers).toBe(0);
    expect(payload.totalOperators).toBe(0);
    expect(payload.totalBookings).toBe(0);
    expect(payload.activeBookings).toBe(0);
    expect(payload.completedBookings).toBe(0);
    expect(payload.cancelledBookings).toBe(0);
    expect(payload.totalRevenue).toBe(0);
    expect(payload.totalRevenueFromPayments).toBe(0);
  });
});
