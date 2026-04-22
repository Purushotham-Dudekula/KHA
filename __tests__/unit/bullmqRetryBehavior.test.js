const { EventEmitter } = require("events");

describe("BullMQ retry/DLQ behavior (mocked, no Redis)", () => {
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
          return { id: "job-1" };
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

  test("webhookQueue: enqueue uses attempts/backoff and DLQ only on final failure", async () => {
    const queues = [];
    const { MockQueue, MockWorker } = mockBullmq({ queues });

    jest.doMock("bullmq", () => ({ Queue: MockQueue, Worker: MockWorker }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: () => ({}) }));

    const { enqueueRazorpayWebhookJob, startWebhookWorker } = require("../../src/queues/webhook.queue");

    await enqueueRazorpayWebhookJob({ paymentId: "pay_1", webhookEvent: "payment.captured", eventId: "evt_1" });
    const addCall = queues.find((q) => q.queue === "webhookQueue");
    expect(addCall).toBeTruthy();
    const [, , opts] = addCall.args;
    expect(opts.attempts).toBe(5);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });

    // Worker DLQ behavior
    process.env.NODE_ENV = "development";
    const worker = startWebhookWorker();
    expect(worker).toBeTruthy();

    // Simulate 4 failures (not final) => no DLQ
    for (let i = 1; i <= 4; i += 1) {
      worker.emit(
        "failed",
        { id: `j${i}`, name: "razorpay.payment.captured", data: { paymentId: "pay_1" }, attemptsMade: i, opts: { attempts: 5 } },
        new Error("boom")
      );
    }
    expect(queues.some((q) => q.queue === "webhookQueueDLQ")).toBe(false);

    // Final failure => DLQ add
    worker.emit(
      "failed",
      { id: "j5", name: "razorpay.payment.captured", data: { paymentId: "pay_1", webhookEvent: "payment.captured" }, attemptsMade: 5, opts: { attempts: 5 } },
      new Error("boom")
    );
    expect(queues.some((q) => q.queue === "webhookQueueDLQ")).toBe(true);
  });

  test("paymentQueue: reconcile job uses attempts/backoff and DLQ only on final failure", async () => {
    const queues = [];
    const { MockQueue, MockWorker } = mockBullmq({ queues });

    jest.doMock("bullmq", () => ({ Queue: MockQueue, Worker: MockWorker }));
    jest.doMock("../../src/queues/redis.connection", () => ({ createBullConnection: () => ({}) }));

    const { enqueueReconcilePaymentsJob, startPaymentWorker } = require("../../src/queues/payment.queue");

    await enqueueReconcilePaymentsJob();
    const addCall = queues.find((q) => q.queue === "paymentQueue");
    expect(addCall).toBeTruthy();
    const [, , opts] = addCall.args;
    expect(opts.attempts).toBe(5);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
    expect(opts.jobId).toBe("reconcilePayments");

    process.env.NODE_ENV = "development";
    const worker = startPaymentWorker();
    expect(worker).toBeTruthy();

    for (let i = 1; i <= 4; i += 1) {
      worker.emit(
        "failed",
        { id: `p${i}`, name: "reconcilePayments", data: {}, attemptsMade: i, opts: { attempts: 5 } },
        new Error("boom")
      );
    }
    expect(queues.some((q) => q.queue === "paymentQueueDLQ")).toBe(false);

    worker.emit(
      "failed",
      { id: "p5", name: "reconcilePayments", data: {}, attemptsMade: 5, opts: { attempts: 5 } },
      new Error("boom")
    );
    expect(queues.some((q) => q.queue === "paymentQueueDLQ")).toBe(true);
  });
});

