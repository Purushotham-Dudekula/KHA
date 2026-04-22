jest.mock("mongoose", () => ({
  connection: { readyState: 1 },
  connect: jest.fn(),
}));
jest.mock("../../../src/models/payment.model", () => ({
  find: jest.fn(),
  updateOne: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock("../../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../src/queues/redis.connection", () => ({
  createBullConnection: jest.fn(),
}));
jest.mock("../../../src/services/razorpayStatus.service", () => ({
  fetchRazorpayPaymentStatus: jest.fn(),
}));
jest.mock("../../../src/services/paymentFinalizer.service", () => ({
  finalizeRazorpayPaymentCaptured: jest.fn(),
}));
jest.mock("../../../src/services/redisLock.service", () => ({
  acquireLock: jest.fn(async () => ({ acquired: true, token: "t" })),
  releaseLock: jest.fn(async () => true),
}));

const Payment = require("../../../src/models/payment.model");
const { createBullConnection } = require("../../../src/queues/redis.connection");
const razorpayStatusService = require("../../../src/services/razorpayStatus.service");
const { finalizeRazorpayPaymentCaptured } = require("../../../src/services/paymentFinalizer.service");

describe("payment.queue (more unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    finalizeRazorpayPaymentCaptured.mockResolvedValue({ ok: true });
  });

  test("enqueueReconcilePaymentsJob returns false when queue unavailable", async () => {
    createBullConnection.mockReturnValueOnce(null);
    const { enqueueReconcilePaymentsJob } = require("../../../src/queues/payment.queue");
    await expect(enqueueReconcilePaymentsJob()).resolves.toBe(false);
  });

  test("reconcilePaymentsOnce handles empty pending list", async () => {
    Payment.find.mockReturnValueOnce({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });
    const { reconcilePaymentsOnce } = require("../../../src/queues/payment.queue");
    const out = await reconcilePaymentsOnce();
    expect(out).toEqual({ processed: 0 });
  });

  test("reconcilePaymentsOnce marks failed and captured branches", async () => {
    Payment.find.mockReturnValueOnce({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: () =>
              Promise.resolve([
                { _id: "1", paymentId: "p1", bookingId: "b1", createdAt: new Date() },
                { _id: "2", paymentId: "p2", bookingId: "b2", createdAt: new Date() },
              ]),
          }),
        }),
      }),
    });
    razorpayStatusService.fetchRazorpayPaymentStatus
      .mockResolvedValueOnce({ ok: true, status: "failed" })
      .mockResolvedValueOnce({ ok: true, status: "captured" });
    Payment.aggregate.mockResolvedValueOnce([]);
    const { reconcilePaymentsOnce } = require("../../../src/queues/payment.queue");
    const out = await reconcilePaymentsOnce();
    expect(Payment.updateOne).toHaveBeenCalled();
    expect(finalizeRazorpayPaymentCaptured).toHaveBeenCalled();
    expect(out.processed).toBeGreaterThanOrEqual(1);
  });

  test("startPaymentWorker returns null in test env", () => {
    process.env.NODE_ENV = "test";
    const { startPaymentWorker } = require("../../../src/queues/payment.queue");
    expect(startPaymentWorker()).toBeNull();
  });
});

