const mongoose = require("mongoose");

jest.mock("../../src/services/redisLock.service", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));

const { acquireLock, releaseLock } = require("../../src/services/redisLock.service");
const { finalizeRazorpayPaymentCaptured } = require("../../src/services/paymentFinalizer.service");
const Payment = require("../../src/models/payment.model");
const Booking = require("../../src/models/booking.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("paymentFinalizer.service (coverage)", () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    acquireLock.mockResolvedValue({ acquired: true, token: "t1", skipped: false });
    releaseLock.mockResolvedValue();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Advance payment -> booking confirmed", async () => {
    const booking = await Booking.create({
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
      tractor: new mongoose.Types.ObjectId(),
      status: "accepted",
      paymentStatus: "advance_due",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      time: "10:00",
      address: "x",
      baseAmount: 2500,
      gstAmount: 0,
      platformFee: 250,
      totalAmount: 2750,
      estimatedAmount: 2750,
      finalAmount: 2750,
      advancePayment: 825,
      advanceAmount: 825,
      remainingAmount: 1925,
    });

    await Payment.create({
      bookingId: booking._id,
      userId: booking.farmer,
      amount: 825,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_fin_adv_1",
      orderId: "order_fin_adv_1",
    });

    const out = await finalizeRazorpayPaymentCaptured({
      paymentId: "pay_fin_adv_1",
      webhookEvent: "payment.captured",
      source: "webhook",
    });

    expect(out.ok).toBe(true);
    const refreshed = await Booking.findById(booking._id).lean();
    expect(refreshed.status).toBe("confirmed");
    const payRow = await Payment.findOne({ paymentId: "pay_fin_adv_1" }).lean();
    expect(payRow.status).toBe("SUCCESS");
  });

  test("Remaining payment -> booking closed when fully_paid + payment_pending", async () => {
    const booking = await Booking.create({
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
      tractor: new mongoose.Types.ObjectId(),
      status: "payment_pending",
      paymentStatus: "fully_paid",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      time: "10:00",
      address: "x",
      baseAmount: 2500,
      gstAmount: 0,
      platformFee: 250,
      totalAmount: 2750,
      estimatedAmount: 2750,
      finalAmount: 2750,
      advancePayment: 825,
      advanceAmount: 825,
      remainingAmount: 1925,
    });

    await Payment.create({
      bookingId: booking._id,
      userId: booking.farmer,
      amount: 1925,
      type: "remaining",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_fin_rem_1",
      orderId: "order_fin_rem_1",
    });

    const out = await finalizeRazorpayPaymentCaptured({
      paymentId: "pay_fin_rem_1",
      webhookEvent: "payment.captured",
      source: "webhook",
    });

    expect(out.ok).toBe(true);
    const refreshed = await Booking.findById(booking._id).lean();
    expect(refreshed.status).toBe("closed");
  });

  test("Duplicate finalization prevented -> alreadyProcessed true on second run", async () => {
    const booking = await Booking.create({
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
      tractor: new mongoose.Types.ObjectId(),
      status: "accepted",
      paymentStatus: "advance_due",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      time: "10:00",
      address: "x",
      baseAmount: 2500,
      gstAmount: 0,
      platformFee: 250,
      totalAmount: 2750,
      estimatedAmount: 2750,
      finalAmount: 2750,
      advancePayment: 825,
      advanceAmount: 825,
      remainingAmount: 1925,
    });

    await Payment.create({
      bookingId: booking._id,
      userId: booking.farmer,
      amount: 825,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_fin_dup_1",
      orderId: "order_fin_dup_1",
    });

    const a = await finalizeRazorpayPaymentCaptured({
      paymentId: "pay_fin_dup_1",
      webhookEvent: "payment.captured",
      source: "webhook",
    });
    const b = await finalizeRazorpayPaymentCaptured({
      paymentId: "pay_fin_dup_1",
      webhookEvent: "payment.captured",
      source: "webhook",
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.alreadyProcessed).toBe(true);
  });

  test("Lock failure -> safe error returned", async () => {
    acquireLock.mockResolvedValue({ acquired: false, token: null });
    const out = await finalizeRazorpayPaymentCaptured({
      paymentId: "pay_lock_fail_1",
      webhookEvent: "payment.captured",
      source: "webhook",
    });
    expect(out.ok).toBe(false);
  });
});

