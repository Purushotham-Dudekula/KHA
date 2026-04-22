const { EventEmitter } = require("events");

describe("advanced queue behavior", () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function mockBullmq({ queues }) {
    class MockQueue {
      constructor(name) {
        this.name = name;
        this.add = jest.fn(async (...args) => {
          queues.push({ queue: name, args });
          return { id: `job-${queues.length}` };
        });
      }
    }

    class MockWorker extends EventEmitter {
      constructor(name, processor) {
        super();
        this.name = name;
        this.processor = processor;
      }
    }

    return { MockQueue, MockWorker };
  }

  test("notification worker succeeds on retry after one failure", async () => {
    const queues = [];
    const { MockQueue, MockWorker } = mockBullmq({ queues });
    jest.doMock("bullmq", () => ({ Queue: MockQueue, Worker: MockWorker }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: () => ({}) }));

    const processFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);

    process.env.NODE_ENV = "development";
    const { startNotificationWorker } = require("../../src/queues/notification.queue");
    const worker = startNotificationWorker(processFn);

    await expect(worker.processor({ data: { notificationId: "n1" } })).rejects.toThrow(
      "transient failure"
    );
    await expect(worker.processor({ data: { notificationId: "n1" } })).resolves.toBeUndefined();
    expect(processFn).toHaveBeenCalledTimes(2);
    expect(processFn).toHaveBeenNthCalledWith(1, { notificationId: "n1" });
    expect(processFn).toHaveBeenNthCalledWith(2, { notificationId: "n1" });
  });

  test("notification queue moves final failure to DLQ", async () => {
    const queues = [];
    const { MockQueue, MockWorker } = mockBullmq({ queues });
    jest.doMock("bullmq", () => ({ Queue: MockQueue, Worker: MockWorker }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: () => ({}) }));

    process.env.NODE_ENV = "development";
    const { startNotificationWorker } = require("../../src/queues/notification.queue");
    const worker = startNotificationWorker(jest.fn().mockRejectedValue(new Error("boom")));

    worker.emit(
      "failed",
      {
        id: "n5",
        name: "notification.retry",
        data: { userId: "u1" },
        attemptsMade: 5,
        opts: { attempts: 5 },
      },
      new Error("boom")
    );

    expect(queues.some((q) => q.queue === "notificationQueueDLQ")).toBe(true);
    const dlqAdd = queues.find((q) => q.queue === "notificationQueueDLQ");
    expect(dlqAdd.args[0]).toBe("notification.retry");
    expect(dlqAdd.args[1]).toEqual(
      expect.objectContaining({
        originalQueue: "notificationQueue",
        payload: { userId: "u1" },
        error: "boom",
      })
    );
  });
});
