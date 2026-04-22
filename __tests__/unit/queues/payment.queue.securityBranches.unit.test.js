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
const razorpayStatusService = require("../../../src/services/razorpayStatus.service");
const { finalizeRazorpayPaymentCaptured } = require("../../../src/services/paymentFinalizer.service");
const { reconcilePaymentsOnce } = require("../../../src/queues/payment.queue");

describe("payment.queue security-critical reconciliation branches", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    delete process.env.ALLOW_RECONCILE_FALLBACK;
    finalizeRazorpayPaymentCaptured.mockResolvedValue({ ok: true });
  });

  test("does not assume captured when fallback disabled and provider lookup fails", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_RECONCILE_FALLBACK = "false";

    Payment.find.mockReturnValueOnce({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: () =>
              Promise.resolve([{ _id: "p1", paymentId: "pay_1", bookingId: "b1", status: "PENDING" }]),
          }),
        }),
      }),
    });
    razorpayStatusService.fetchRazorpayPaymentStatus.mockResolvedValueOnce({
      ok: false,
      error: new Error("network down"),
    });
    Payment.aggregate.mockResolvedValueOnce([]);

    const out = await reconcilePaymentsOnce();

    expect(finalizeRazorpayPaymentCaptured).not.toHaveBeenCalled();
    expect(Payment.updateOne).not.toHaveBeenCalled();
    expect(out).toEqual({ processed: 0 });
  });

  test("repairs mismatch records by re-running finalizer for success payments", async () => {
    Payment.find.mockReturnValueOnce({
      select: () => ({
        sort: () => ({
          limit: () => ({
            // Keep one non-actionable pending row so reconcile continues
            // past the early return and executes mismatch-repair logic.
            lean: () => Promise.resolve([{ _id: "noop", paymentId: "", bookingId: "b-noop", status: "PENDING" }]),
          }),
        }),
      }),
    });
    Payment.aggregate.mockResolvedValueOnce([
      { paymentId: "pay_fix_1", type: "advance", bookingStatus: "pending" },
      { paymentId: "pay_fix_2", type: "remaining", bookingStatus: "confirmed" },
    ]);

    const out = await reconcilePaymentsOnce();

    expect(out).toEqual({ processed: 0 });
    expect(finalizeRazorpayPaymentCaptured).toHaveBeenCalledTimes(2);
    expect(finalizeRazorpayPaymentCaptured).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ paymentId: "pay_fix_1", source: "reconciliation" })
    );
    expect(finalizeRazorpayPaymentCaptured).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paymentId: "pay_fix_2", source: "reconciliation" })
    );
  });
});
