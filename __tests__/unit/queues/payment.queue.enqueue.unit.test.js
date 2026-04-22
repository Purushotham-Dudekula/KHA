const mockAdd = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
  Worker: jest.fn(),
}));

const mockCreateBullConnection = jest.fn();
jest.mock("../../../src/queues/redis.connection", () => ({
  createBullConnection: (...args) => mockCreateBullConnection(...args),
}));

const { enqueueReconcilePaymentsJob } = require("../../../src/queues/payment.queue");

describe("payment.queue enqueueReconcilePaymentsJob", () => {
  beforeEach(() => {
    mockAdd.mockClear();
    mockCreateBullConnection.mockReset();
  });

  test("returns true when queue add succeeds", async () => {
    mockCreateBullConnection.mockReturnValue({});
    await expect(enqueueReconcilePaymentsJob()).resolves.toBe(true);
    expect(mockAdd).toHaveBeenCalledWith("reconcilePayments", expect.any(Object), expect.any(Object));
  });

  test("returns false when no redis connection", async () => {
    mockCreateBullConnection.mockReturnValue(null);
    await expect(enqueueReconcilePaymentsJob()).resolves.toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
