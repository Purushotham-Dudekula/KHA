const mongoose = require("mongoose");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  };
}

function oid(v = "507f191e810c19729de860ea") {
  return new mongoose.Types.ObjectId(v);
}

describe("booking.controller ultra coverage", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.NODE_ENV;
  });

  test("createBooking validation failures: empty body, missing serviceType/date/time, invalid time", async () => {
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();
    const baseReq = {
      user: { role: "farmer", _id: oid(), landArea: 2 },
      requestId: "r1",
    };

    await ctrl.createBooking({ ...baseReq, body: {} }, makeRes(), next);
    await ctrl.createBooking(
      {
        ...baseReq,
        body: {
          operatorId: String(oid("507f191e810c19729de860eb")),
          tractorId: String(oid("507f191e810c19729de860ec")),
          landArea: 2,
          date: new Date(Date.now() + 86400000).toISOString(),
          time: "10:10",
        },
      },
      makeRes(),
      next
    );
    await ctrl.createBooking(
      {
        ...baseReq,
        body: {
          operatorId: String(oid("507f191e810c19729de860eb")),
          tractorId: String(oid("507f191e810c19729de860ec")),
          landArea: 2,
          serviceType: "x",
          time: "10:10",
        },
      },
      makeRes(),
      next
    );
    await ctrl.createBooking(
      {
        ...baseReq,
        body: {
          operatorId: String(oid("507f191e810c19729de860eb")),
          tractorId: String(oid("507f191e810c19729de860ec")),
          landArea: 2,
          serviceType: "x",
          date: new Date(Date.now() + 86400000).toISOString(),
          time: "10-10",
        },
      },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("createBooking duplicate booking path via Booking.exists", async () => {
    const bookingExists = jest.fn().mockResolvedValue(true);
    jest.doMock("../../src/models/booking.model", () => {
      const fn = {};
      fn.exists = bookingExists;
      fn.FARMER_ACTIVE_BOOKING_STATUSES = ["pending"];
      fn.applyAdvanceFieldDedupe = jest.fn((x) => x);
      return fn;
    });
    jest.doMock("../../src/services/pricingCache.service", () => ({
      getPricingByServiceTypeCached: jest.fn().mockResolvedValue({ pricePerAcre: 100 }),
    }));
    jest.doMock("../../src/services/commissionCache.service", () => ({
      getActiveCommissionCached: jest.fn().mockResolvedValue({ percentage: 10 }),
    }));
    jest.doMock("../../src/models/seasonalPricing.model", () => ({
      findOne: jest.fn(() => ({ sort: () => ({ lean: jest.fn().mockResolvedValue(null) }) })),
    }));
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();
    await ctrl.createBooking(
      {
        user: { role: "farmer", _id: oid(), landArea: 2 },
        requestId: "r2",
        body: {
          operatorId: String(oid("507f191e810c19729de860eb")),
          tractorId: String(oid("507f191e810c19729de860ec")),
          landArea: 2,
          serviceType: "test-service",
          date: new Date(Date.now() + 86400000).toISOString(),
          time: "10:10",
        },
      },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  test("payAdvance lock failure and timeout style response", async () => {
    process.env.NODE_ENV = "production";
    jest.doMock("../../src/services/redisLock.service", () => ({
      acquireLock: jest.fn().mockResolvedValue({ acquired: false }),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock("../../src/utils/featureFlags", () => ({ isPaymentsEnabled: jest.fn(() => true) }));
    jest.doMock("../../src/services/payment.service", () => ({
      verifyPayment: jest.fn().mockResolvedValue({ verified: true }),
      fetchPaymentAmountRupees: jest.fn(),
      isPaymentIdReused: jest.fn(),
    }));
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const res = makeRes();
    const next = jest.fn();
    await ctrl.payAdvance(
      {
        user: { role: "farmer", _id: oid() },
        params: { id: String(oid()) },
        body: {
          paymentMethod: "upi",
          orderId: "ord_1",
          paymentId: "pay_1",
          signature: "sig_1",
        },
      },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalled();
  });

  test("respondToBooking not found and invalid state transitions", async () => {
    const findById = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: oid(),
        operator: { equals: () => true },
        status: "accepted",
      });
    jest.doMock("../../src/models/booking.model", () => {
      const fn = {};
      fn.findById = findById;
      fn.exists = jest.fn();
      fn.findOneAndUpdate = jest.fn();
      fn.applyAdvanceFieldDedupe = jest.fn((x) => x);
      fn.FARMER_ACTIVE_BOOKING_STATUSES = ["pending"];
      return fn;
    });
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();

    await ctrl.respondToBooking(
      { user: { role: "operator", _id: oid() }, params: { id: String(oid()) }, body: { action: "accept" } },
      makeRes(),
      next
    );
    await ctrl.respondToBooking(
      { user: { role: "operator", _id: oid() }, params: { id: String(oid()) }, body: { action: "accept" } },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("cancelBooking invalid transitions: already cancelled/completed", async () => {
    const findById = jest
      .fn()
      .mockResolvedValueOnce({
        _id: oid(),
        farmer: { equals: () => true },
        operator: { equals: () => false },
        status: "cancelled",
      })
      .mockResolvedValueOnce({
        _id: oid(),
        farmer: { equals: () => true },
        operator: { equals: () => false },
        status: "completed",
      });
    jest.doMock("../../src/models/booking.model", () => {
      const fn = {};
      fn.findById = findById;
      fn.applyAdvanceFieldDedupe = jest.fn((x) => x);
      fn.FARMER_ACTIVE_BOOKING_STATUSES = ["pending"];
      return fn;
    });
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();
    const req = { user: { role: "farmer", _id: oid() }, params: { id: String(oid()) }, body: {} };
    await ctrl.cancelBooking(req, makeRes(), next);
    await ctrl.cancelBooking(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("list/preview/detail/invoice/track validation and auth failures", async () => {
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();
    const badIdReq = { user: { role: "farmer", _id: oid() }, params: { id: "bad" }, query: {}, body: {} };

    await ctrl.getBookingRefundPreview({ ...badIdReq, user: { role: "guest", _id: oid() } }, makeRes(), next);
    await ctrl.getBookingRefundPreview(badIdReq, makeRes(), next);
    await ctrl.listFarmerBookings({ user: { role: "operator", _id: oid() }, query: {} }, makeRes(), next);
    await ctrl.listOperatorBookings({ user: { role: "farmer", _id: oid() }, query: {} }, makeRes(), next);
    await ctrl.listMyFarmerBookings({ user: { role: "operator", _id: oid() }, query: {} }, makeRes(), next);
    await ctrl.listMyOperatorBookings({ user: { role: "farmer", _id: oid() }, query: {} }, makeRes(), next);
    await ctrl.getBookingDetails(badIdReq, makeRes(), next);
    await ctrl.getBookingInvoice(badIdReq, makeRes(), next);
    await ctrl.trackBooking(badIdReq, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(9);
  });

  test("estimateBooking validation failures", async () => {
    const ctrl = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();
    const res = makeRes();
    const base = { user: { role: "farmer", _id: oid() }, query: {}, params: {}, body: {} };
    await ctrl.estimateBooking({ ...base, user: { role: "operator", _id: oid() } }, res, next);
    await ctrl.estimateBooking(
      {
        ...base,
        body: {
          serviceType: "",
          date: new Date(Date.now() + 86400000).toISOString(),
          time: "10:00",
          landArea: 2,
        },
      },
      res,
      next
    );
    await ctrl.estimateBooking(
      {
        ...base,
        body: {
          serviceType: "s",
          date: "bad-date",
          time: "10:00",
          landArea: 2,
        },
      },
      res,
      next
    );
    expect(next).toHaveBeenCalledTimes(3);
  });
});
