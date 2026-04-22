/**
 * Unit tests for bookingPaymentLock.cron — mocks DB/redis; does not run real transactions.
 */
const mongoose = require("mongoose");

jest.mock("../../../src/services/redisLock.service", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));

jest.mock("../../../src/models/booking.model", () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));

const Booking = require("../../../src/models/booking.model");
const { logger } = require("../../../src/utils/logger");
const { expireOnce, scheduleBookingPaymentLockExpiry, PAYMENT_PENDING_TTL_MS } = require("../../../src/jobs/bookingPaymentLock.cron");

describe("bookingPaymentLock.cron", () => {
  const mockSession = {
    endSession: jest.fn().mockResolvedValue(undefined),
    withTransaction: jest.fn(async (fn) => {
      await fn();
    }),
  };

  beforeEach(() => {
    jest.spyOn(mongoose, "startSession").mockResolvedValue(mockSession);
    mongoose.connection.readyState = 1;
    mockSession.withTransaction.mockImplementation(async (fn) => {
      await fn();
    });
    mockSession.endSession.mockClear();
    Booking.find.mockReset();
    Booking.findOne.mockReset();
    Booking.countDocuments.mockReset();
    Booking.countDocuments.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("PAYMENT_PENDING_TTL_MS is exported", () => {
    expect(PAYMENT_PENDING_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("expireOnce with no candidates completes", async () => {
    Booking.find.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    await expireOnce();
    expect(Booking.find).toHaveBeenCalled();
  });

  test("expireOnce cancels expired payment_pending booking", async () => {
    const id = new mongoose.Types.ObjectId();
    const farmer = new mongoose.Types.ObjectId();
    const operator = new mongoose.Types.ObjectId();
    const lockExpiresAt = new Date(Date.now() - 60_000);
    const save = jest.fn().mockResolvedValue(undefined);
    const row = {
      _id: id,
      status: "payment_pending",
      lockExpiresAt,
      cancelledBy: null,
      cancellationReason: null,
      save,
    };

    Booking.find.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: jest.fn().mockResolvedValue([
            {
              _id: id,
              farmer,
              operator,
              status: "payment_pending",
              lockExpiresAt,
            },
          ]),
        }),
      }),
    });

    Booking.findOne.mockImplementation(() => ({
      session: () => Promise.resolve(row),
    }));

    await expireOnce();

    expect(row.status).toBe("cancelled");
    expect(row.cancelledBy).toBe("system");
    expect(save).toHaveBeenCalled();
  });

  test("expireOnce logs error when withTransaction throws", async () => {
    const id = new mongoose.Types.ObjectId();
    Booking.find.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: jest.fn().mockResolvedValue([{ _id: id }]),
        }),
      }),
    });
    mockSession.withTransaction.mockImplementationOnce(async () => {
      throw new Error("txn failed");
    });
    jest.spyOn(logger, "error").mockImplementation(() => {});

    await expireOnce();

    expect(logger.error).toHaveBeenCalledWith(
      "[LOCK_EXPIRED] expiry transaction failed",
      expect.objectContaining({ bookingId: String(id) })
    );
  });

  test("scheduleBookingPaymentLockExpiry does not register cron in test env", () => {
    const cron = require("node-cron");
    const spy = jest.spyOn(cron, "schedule").mockImplementation(() => {});
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    scheduleBookingPaymentLockExpiry();
    expect(spy).not.toHaveBeenCalled();
    process.env.NODE_ENV = prev;
    spy.mockRestore();
  });
});
