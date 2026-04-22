jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));

jest.mock("../../src/models/booking.model", () => ({
  create: jest.fn(),
  findById: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  FARMER_ACTIVE_BOOKING_STATUSES: ["pending"],
}));
jest.mock("../../src/models/user.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/models/tractor.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/models/payment.model", () => ({}));
jest.mock("../../src/models/pricing.model", () => ({}));
jest.mock("../../src/models/seasonalPricing.model", () => ({ findOne: jest.fn(() => ({ sort: () => ({ lean: () => Promise.resolve(null) }) })) }));
jest.mock("../../src/models/commission.model", () => ({}));
jest.mock("../../src/models/offer.model", () => ({}));

jest.mock("../../src/services/notification.service", () => ({ notifyUser: jest.fn(), notifyAdvanceReceived: jest.fn() }));
jest.mock("../../src/services/payment.service", () => ({ verifyPayment: jest.fn(), fetchPaymentAmountRupees: jest.fn(), isPaymentIdReused: jest.fn() }));
jest.mock("../../src/services/ledger.service", () => ({ logPaymentSuccess: jest.fn() }));
jest.mock("../../src/services/bookingSettlement.service", () => ({ applyBookingSettlementAfterFullPayment: jest.fn() }));
jest.mock("../../src/services/razorpayStatus.service", () => ({ fetchRazorpayPaymentStatus: jest.fn() }));
jest.mock("../../src/services/paymentFinalizer.service", () => ({ finalizeRazorpayPaymentCaptured: jest.fn() }));
jest.mock("../../src/services/operatorEligibility.service", () => ({ canOperatorServeBookings: jest.fn() }));
jest.mock("../../src/services/maps.service", () => ({ getDistanceAndETA: jest.fn(async () => ({ distanceKm: 1, durationMinutes: 1 })) }));
jest.mock("../../src/services/storage.service", () => ({ uploadFile: jest.fn(), resolveDocumentInput: jest.fn() }));
jest.mock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));
jest.mock("../../src/services/redisLock.service", () => ({ acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => true) }));
jest.mock("../../src/services/commissionCache.service", () => ({ getActiveCommissionCached: jest.fn() }));
jest.mock("../../src/services/pricingCache.service", () => ({ getPricingByServiceTypeCached: jest.fn() }));

const Tractor = require("../../src/models/tractor.model");
const { getActiveCommissionCached } = require("../../src/services/commissionCache.service");
const { getPricingByServiceTypeCached } = require("../../src/services/pricingCache.service");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("booking.controller (coverage unit)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("createBooking -> 403 for non-farmer", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await createBooking({ user: { role: "operator" }, body: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 400 invalid tractorId when tractorId provided", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { tractorId: "bad", date: "2099-01-01", time: "10:00", serviceType: "x" } },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 404 tractor not found", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    Tractor.findById.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(null) });
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      {
        user: { role: "farmer", landArea: 1 },
        body: { tractorId: "507f1f77bcf86cd799439011", date: "2099-01-01", time: "10:00", serviceType: "x" },
      },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 400 tractor must be approved+available", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    Tractor.findById.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce({ verificationStatus: "pending", isAvailable: false }) });
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      {
        user: { role: "farmer", landArea: 1 },
        body: { tractorId: "507f1f77bcf86cd799439011", date: "2099-01-01", time: "10:00", serviceType: "x" },
      },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("createBooking -> 400 operatorId required in legacy flow", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { date: "2099-01-01", time: "10:00", serviceType: "x" } },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("createBooking -> 400 landArea missing from body+profile", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      {
        user: { role: "farmer", landArea: undefined },
        body: { operatorId: "507f1f77bcf86cd799439011", tractorId: "507f1f77bcf86cd799439011", date: "2099-01-01", time: "10:00", serviceType: "x" },
      },
      res,
      next
    );
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 400 date invalid / past", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res1 = makeRes();
    const next1 = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { operatorId: "507f1f77bcf86cd799439011", tractorId: "507f1f77bcf86cd799439011", date: "not-a-date", time: "10:00", serviceType: "x" } },
      res1,
      next1
    );
    expect(next1).toHaveBeenCalledWith(expect.any(Error));

    const res2 = makeRes();
    const next2 = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { operatorId: "507f1f77bcf86cd799439011", tractorId: "507f1f77bcf86cd799439011", date: "2000-01-01", time: "10:00", serviceType: "x" } },
      res2,
      next2
    );
    expect(next2).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 400 invalid time format", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { operatorId: "507f1f77bcf86cd799439011", tractorId: "507f1f77bcf86cd799439011", date: "2099-01-01", time: "bad", serviceType: "x" } },
      res,
      next
    );
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("createBooking -> 400 when commission missing", async () => {
    const { createBooking } = require("../../src/controllers/booking/booking.index.js");
    getPricingByServiceTypeCached.mockResolvedValueOnce({ pricePerAcre: 10 });
    getActiveCommissionCached.mockResolvedValueOnce(null);
    const res = makeRes();
    const next = jest.fn();
    await createBooking(
      { user: { role: "farmer", landArea: 1 }, body: { operatorId: "507f1f77bcf86cd799439011", tractorId: "507f1f77bcf86cd799439011", date: "2099-01-01", time: "10:00", serviceType: "x" } },
      res,
      next
    );
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

