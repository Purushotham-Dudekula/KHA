const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../../src/services/payment.service", () => {
  const actual = jest.requireActual("../../src/services/payment.service");
  return {
    ...actual,
    refundUpiPayment: jest.fn(async () => ({ ok: true, refund: { id: "rfnd_idem_1" } })),
  };
});

const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures, createPendingBookingForFarmer } = require("../helpers/mongoMemoryHarness");
const Admin = require("../../src/models/admin.model");
const Payment = require("../../src/models/payment.model");
const { refundUpiPayment } = require("../../src/services/payment.service");

describe("admin refund route idempotency", () => {
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
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("same Idempotency-Key on refund approval returns cached response without re-processing", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
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
      transactionId: "txn_refund_idem_1",
      orderId: "order_refund_idem_1",
      paymentId: "pay_refund_idem_1",
      refundStatus: "none",
    });

    const admin = await Admin.create({
      name: "Admin Refund Idem",
      email: "admin.refund.idem@test.local",
      role: "admin",
      isActive: true,
    });
    const adminToken = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    const idem = "idem_admin_refund_1";
    const first = await request(app)
      .post(`/api/v1/admin/refunds/${booking._id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Idempotency-Key", idem)
      .send({ action: "approve", refundReason: "idem test" });

    const second = await request(app)
      .post(`/api/v1/admin/refunds/${booking._id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Idempotency-Key", idem)
      .send({ action: "approve", refundReason: "idem test" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(refundUpiPayment).toHaveBeenCalledTimes(1);
  });
});
