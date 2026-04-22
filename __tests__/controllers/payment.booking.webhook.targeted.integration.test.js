const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const paymentMockState = {
  verifyShouldPass: true,
  amountFetchOk: true,
  amountFetchAmountRupees: 0,
  refundOk: true,
  refundId: "rfnd_test_1",
};

jest.mock("../../src/services/payment.service", () => {
  const actual = jest.requireActual("../../src/services/payment.service");
  return {
    ...actual,
    verifyPayment: jest.fn(async (data) => ({
      verified: Boolean(paymentMockState.verifyShouldPass),
      orderId: data?.razorpay_order_id || data?.orderId || "",
      paymentId: data?.razorpay_payment_id || data?.paymentId || "",
      message: paymentMockState.verifyShouldPass ? undefined : "Invalid signature",
    })),
    fetchPaymentAmountRupees: jest.fn(async () => {
      if (!paymentMockState.amountFetchOk) {
        return { ok: false, error: new Error("fetch failed") };
      }
      return { ok: true, amountRupees: Number(paymentMockState.amountFetchAmountRupees), raw: {} };
    }),
    refundUpiPayment: jest.fn(async () => {
      if (!paymentMockState.refundOk) {
        return { ok: false, error: new Error("refund failed") };
      }
      return { ok: true, refund: { id: String(paymentMockState.refundId || "rfnd_test_1") } };
    }),
  };
});

jest.mock("../../src/services/redisLock.service", () => ({
  acquireLock: jest.fn(async () => ({ acquired: true, token: "lock_token_test", skipped: false })),
  releaseLock: jest.fn(async () => {}),
}));

jest.mock("../../src/queues/webhook.queue", () => ({
  enqueueRazorpayWebhookJob: jest.fn(async () => ({ ok: true })),
}));

const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");
const { expireOnce } = require("../../src/jobs/bookingPaymentLock.cron");
const Booking = require("../../src/models/booking.model");
const Payment = require("../../src/models/payment.model");
const WebhookEvent = require("../../src/models/webhookEvent.model");
const Admin = require("../../src/models/admin.model");
const User = require("../../src/models/user.model");
const { refundUpiPayment } = require("../../src/services/payment.service");
const { verifyPayment } = require("../../src/services/payment.service");
const { enqueueRazorpayWebhookJob } = require("../../src/queues/webhook.queue");

function signWebhook(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(raw)
    .digest("hex");
}

function futureDateStr(days = 3) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

describe("payment + booking + webhook targeted coverage", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_targeted_tests";
    delete process.env.REDIS_URL;

    paymentMockState.verifyShouldPass = true;
    paymentMockState.amountFetchOk = true;
    paymentMockState.amountFetchAmountRupees = 0;
    paymentMockState.refundOk = true;
    paymentMockState.refundId = "rfnd_test_1";
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Double advance payment for same booking: second attempt replays cached response", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const idem = "idem_double_advance_same_booking";
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idem)
        .send({ paymentMethod: "upi", paymentId: "pay_double_1", orderId: "order_double_1", signature: "sig" }),
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .set("Idempotency-Key", idem)
        .send({ paymentMethod: "upi", paymentId: "pay_double_1", orderId: "order_double_1", signature: "sig" }),
    ]);

    expect(second.status).toBe(first.status);
    // Response can differ in message/shape because the second request may take the
    // "already recorded" branch; still must be successful and must not duplicate processing.
    expect(second.body.success).toBe(true);
    expect(await Payment.countDocuments({ bookingId: booking._id, type: "advance" })).toBe(1);
    expect(verifyPayment).toHaveBeenCalledTimes(1);
  });

  test("Razorpay amount mismatch: returns 400 and booking status stays unchanged", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_PAYMENT = "false";

    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 100000 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    paymentMockState.amountFetchAmountRupees = Number(booking.advanceAmount || 0) + 1;

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        orderId: "order_amt_mismatch_1",
        paymentId: "pay_amt_mismatch_1",
        signature: "sig_amt_mismatch_1",
      });

    const latest = await Booking.findById(booking._id).lean();
    expect(res.status).toBe(400);
    expect(latest.status).toBe("accepted");
    expect(latest.paymentStatus).toBe("advance_due");
  });

  test("Payment timeout/expiry: payment_pending booking is cancelled and slot is released", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "payment_pending";
    booking.paymentStatus = "advance_paid";
    booking.lockExpiresAt = new Date(Date.now() - 60 * 1000);
    await booking.save();

    await expireOnce();

    const expired = await Booking.findById(booking._id).lean();
    expect(expired.status).toBe("cancelled");
    expect(expired.cancelledBy).toBe("system");
    expect(expired.lockExpiresAt).toBeNull();

    const secondFarmer = await User.create({
      phone: "+919999900099",
      role: "farmer",
      name: "Farmer Slot Reuse",
      landArea: 5,
    });
    const secondFarmerToken = jwt.sign({ id: String(secondFarmer._id) }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    const sameSlotBody = {
      tractorId: String(tractor._id),
      serviceType: "int_test_svc",
      date: futureDateStr(4),
      time: "10:00",
      landArea: 4,
      address: "Same slot after expiry",
    };
    const reuse = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${secondFarmerToken}`)
      .send(sameSlotBody);

    // NOTE: If this ever fails due to a slot conflict, expiry is not fully releasing booking hold.
    expect(reuse.status).toBe(201);
  });

  test("Refund on already-refunded booking: second refund attempt returns 409 and no second Razorpay call", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    const admin = await Admin.create({
      name: "Admin Refund",
      email: "admin.refund@test.local",
      role: "admin",
      isActive: true,
    });
    const adminToken = jwt.sign(
      { id: String(admin._id), scope: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "cancelled";
    booking.cancelledBy = "operator";
    booking.refundStatus = "pending";
    booking.refundAmount = Number(booking.advanceAmount || 0);
    await booking.save();

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: Number(booking.advanceAmount || 0),
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      transactionId: "txn_refund_1",
      orderId: "order_refund_1",
      paymentId: "pay_refund_1",
      refundStatus: "none",
    });

    const first = await request(app)
      .post(`/api/v1/admin/refunds/${booking._id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve", refundReason: "test refund approve" });

    const second = await request(app)
      .post(`/api/v1/admin/refunds/${booking._id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve", refundReason: "duplicate approve" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(refundUpiPayment).toHaveBeenCalledTimes(1);
  });

  test("Double webhook delivery: same event id second delivery returns 200 and does not re-process", async () => {
    const payload = {
      id: "evt_double_delivery_1",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_double_delivery_1" } } },
    };
    const sig = signWebhook(payload);

    const first = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);
    const second = await request(app)
      .post("/api/v1/webhooks/razorpay")
      .set("x-razorpay-signature", sig)
      .send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(enqueueRazorpayWebhookJob).toHaveBeenCalledTimes(1);
    expect(await WebhookEvent.countDocuments({ provider: "razorpay", eventId: "evt_double_delivery_1" })).toBe(1);
  });
});
