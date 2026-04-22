/**
 * paymentReconciliation.cron — schedulePaymentReconciliation() checks NODE_ENV at call time.
 */
jest.mock("node-cron", () => ({
  schedule: jest.fn(),
}));

jest.mock("../../../src/queues/payment.queue", () => ({
  enqueueReconcilePaymentsJob: jest.fn(),
  reconcilePaymentsOnce: jest.fn(),
}));

jest.mock("../../../src/models/payment.model", () => ({
  countDocuments: jest.fn(),
}));

jest.mock("../../../src/models/booking.model", () => ({
  countDocuments: jest.fn(),
}));

const cron = require("node-cron");
const {
  enqueueReconcilePaymentsJob,
  reconcilePaymentsOnce,
} = require("../../../src/queues/payment.queue");
const Payment = require("../../../src/models/payment.model");
const Booking = require("../../../src/models/booking.model");
const { logger } = require("../../../src/utils/logger");
const { schedulePaymentReconciliation } = require("../../../src/jobs/paymentReconciliation.cron");

describe("paymentReconciliation.cron", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "development", RAZORPAY_KEY_ID: "rzp_test" };
    enqueueReconcilePaymentsJob.mockReset();
    reconcilePaymentsOnce.mockReset();
    Payment.countDocuments.mockReset();
    Booking.countDocuments.mockReset();
    cron.schedule.mockClear();
    enqueueReconcilePaymentsJob.mockResolvedValue(false);
    reconcilePaymentsOnce.mockResolvedValue(undefined);
    Payment.countDocuments.mockResolvedValue(0);
    Booking.countDocuments.mockResolvedValue(0);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("schedulePaymentReconciliation is no-op when NODE_ENV is test", () => {
    process.env.NODE_ENV = "test";
    schedulePaymentReconciliation();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  test("cron callback runs inline reconcile when queue returns false (non-production)", async () => {
    schedulePaymentReconciliation();
    expect(cron.schedule).toHaveBeenCalled();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(enqueueReconcilePaymentsJob).toHaveBeenCalled();
    expect(reconcilePaymentsOnce).toHaveBeenCalled();
    expect(Payment.countDocuments).toHaveBeenCalled();
    expect(Booking.countDocuments).toHaveBeenCalled();
  });

  test("cron callback skips inline reconcile when queue enqueues successfully", async () => {
    enqueueReconcilePaymentsJob.mockResolvedValue(true);
    schedulePaymentReconciliation();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(reconcilePaymentsOnce).not.toHaveBeenCalled();
  });

  test("cron callback logs when stuck PENDING payments exist", async () => {
    Payment.countDocuments.mockResolvedValueOnce(2);
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    schedulePaymentReconciliation();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.warn).toHaveBeenCalledWith(
      "[monitor] payments stuck in PENDING > 15m",
      expect.objectContaining({ count: 2 })
    );
  });

  test("cron callback logs error when tick throws", async () => {
    enqueueReconcilePaymentsJob.mockRejectedValueOnce(new Error("queue err"));
    jest.spyOn(logger, "error").mockImplementation(() => {});
    schedulePaymentReconciliation();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(
      "[reconcile] reconciliation tick failed",
      expect.objectContaining({ message: "queue err" })
    );
  });

  test("production + queue unavailable logs error and skips inline", async () => {
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_live";
    enqueueReconcilePaymentsJob.mockResolvedValue(false);
    jest.spyOn(logger, "error").mockImplementation(() => {});
    schedulePaymentReconciliation();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith("[reconcile] Queue unavailable in production (no fallback)");
    expect(reconcilePaymentsOnce).not.toHaveBeenCalled();
  });

  test("cron callback logs when bookings stuck in payment_pending", async () => {
    Payment.countDocuments.mockResolvedValue(0);
    Booking.countDocuments.mockResolvedValue(5);
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    schedulePaymentReconciliation();
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.warn).toHaveBeenCalledWith(
      "[monitor] bookings stuck in PAYMENT_PENDING > 10m",
      expect.objectContaining({ count: 5 })
    );
  });
});
