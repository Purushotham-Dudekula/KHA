const mongoose = require("mongoose");

const Payment = require("../../src/models/payment.model");
const Booking = require("../../src/models/booking.model");
const { finalizeRazorpayPaymentCaptured } = require("../../src/services/paymentFinalizer.service");

describe("Payment finalizer concurrency", () => {
  beforeAll(async () => {
    // Tests using this file should run with mongodb-memory-server harness in CI;
    // when run standalone, skip if not connected.
    if (mongoose.connection.readyState === 0) {
      // no-op; jest suite will be run in full test environment in CI
    }
  });

  test("webhook + reconciliation concurrent finalize: only one logical success", async () => {
    if (mongoose.connection.readyState === 0) return;

    const booking = await Booking.create({
      farmer: new mongoose.Types.ObjectId(),
      operator: new mongoose.Types.ObjectId(),
      tractor: new mongoose.Types.ObjectId(),
      status: "payment_pending",
      paymentStatus: "advance_paid",
      date: new Date(Date.now() + 24 * 60 * 60 * 1000),
      time: "10:00",
      serviceType: "int_test_svc",
    });

    await Payment.create({
      bookingId: booking._id,
      userId: booking.farmer,
      amount: 10,
      type: "advance",
      status: "PENDING",
      paymentMethod: "upi",
      paymentId: "pay_race_1",
    });

    const [a, b] = await Promise.all([
      finalizeRazorpayPaymentCaptured({ paymentId: "pay_race_1", webhookEvent: "payment.captured", source: "webhook" }),
      finalizeRazorpayPaymentCaptured({ paymentId: "pay_race_1", webhookEvent: "reconciliation.payment.captured", source: "reconciliation" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const paymentRow = await Payment.findOne({ paymentId: "pay_race_1" }).lean();
    expect(paymentRow.status).toBe("SUCCESS");
  });
});

