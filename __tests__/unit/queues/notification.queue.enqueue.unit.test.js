/**
 * notification.queue.js — enqueue path with mocked BullMQ + Redis connection.
 */
const mockAdd = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
  Worker: jest.fn(),
}));

const mockCreateBullConnection = jest.fn();
jest.mock("../../../src/queues/redis.connection", () => ({
  createBullConnection: (...args) => mockCreateBullConnection(...args),
}));

const { enqueueNotificationRetryJob } = require("../../../src/queues/notification.queue");

describe("notification.queue enqueueNotificationRetryJob", () => {
  beforeEach(() => {
    mockAdd.mockClear();
    mockCreateBullConnection.mockReset();
  });

  test("returns true and calls queue.add when Redis connection exists", async () => {
    mockCreateBullConnection.mockReturnValue({});
    const ok = await enqueueNotificationRetryJob({ trigger: "unit" });
    expect(ok).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith(
      "notification.retry",
      { trigger: "unit" },
      expect.objectContaining({ attempts: 5 })
    );
  });

  test("returns false when Redis connection is unavailable", async () => {
    mockCreateBullConnection.mockReturnValue(null);
    const ok = await enqueueNotificationRetryJob({ trigger: "noop" });
    expect(ok).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
