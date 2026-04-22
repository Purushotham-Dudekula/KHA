const mockAdd = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
  Worker: jest.fn(),
}));

const mockCreateBullConnection = jest.fn();
jest.mock("../../../src/queues/redis.connection", () => ({
  createBullConnection: (...args) => mockCreateBullConnection(...args),
}));

const mockFinalize = jest.fn().mockResolvedValue({ ok: true });
jest.mock("../../../src/services/paymentFinalizer.service", () => ({
  finalizeRazorpayPaymentCaptured: (...a) => mockFinalize(...a),
}));

const { enqueueRazorpayWebhookJob } = require("../../../src/queues/webhook.queue");

describe("webhook.queue enqueueRazorpayWebhookJob", () => {
  beforeEach(() => {
    mockAdd.mockClear();
    mockCreateBullConnection.mockReset();
    mockFinalize.mockClear();
  });

  test("enqueues when redis connection exists", async () => {
    mockCreateBullConnection.mockReturnValue({});
    await enqueueRazorpayWebhookJob({ paymentId: "pay_1", webhookEvent: "e", eventId: "ev1" });
    expect(mockAdd).toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  test("calls finalize inline when queue unavailable", async () => {
    mockCreateBullConnection.mockReturnValue(null);
    await enqueueRazorpayWebhookJob({ paymentId: "pay_2", webhookEvent: "e2", eventId: "ev2" });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay_2", source: "webhook" }));
  });
});
