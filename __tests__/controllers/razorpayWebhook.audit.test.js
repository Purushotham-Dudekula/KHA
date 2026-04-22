jest.mock("../../src/queues/webhook.queue", () => ({
  enqueueRazorpayWebhookJob: jest.fn(async () => true),
}));
jest.mock("../../src/models/webhookEvent.model", () => ({
  findOneAndUpdate: jest.fn(),
}));
jest.mock("../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const crypto = require("crypto");
const WebhookEvent = require("../../src/models/webhookEvent.model");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("razorpayWebhook audit branches", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 500 when webhook secret missing", async () => {
    const { razorpayWebhook } = require("../../src/controllers/razorpayWebhook.controller");
    process.env.RAZORPAY_WEBHOOK_SECRET = "";
    const res = makeRes();
    await razorpayWebhook({ get: () => "", rawBody: Buffer.from("{}"), body: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("returns 400 when signature/raw body missing", async () => {
    const { razorpayWebhook } = require("../../src/controllers/razorpayWebhook.controller");
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec";
    const res = makeRes();
    await razorpayWebhook({ get: () => "", rawBody: null, body: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns 401 on invalid signature", async () => {
    const { razorpayWebhook } = require("../../src/controllers/razorpayWebhook.controller");
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec";
    const res = makeRes();
    await razorpayWebhook(
      { get: () => "deadbeef", rawBody: Buffer.from("{}"), body: { event: "payment.captured" } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("returns 200 for duplicate event", async () => {
    const { razorpayWebhook } = require("../../src/controllers/razorpayWebhook.controller");
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec";
    const body = {
      id: "evt_1",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1" } } },
      created_at: Date.now(),
    };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = crypto.createHmac("sha256", "whsec").update(raw).digest("hex");
    WebhookEvent.findOneAndUpdate.mockResolvedValueOnce({ _id: "existing" });
    const res = makeRes();
    await razorpayWebhook({ get: () => sig, rawBody: raw, body }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

