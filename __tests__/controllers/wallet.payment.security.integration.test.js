const jwt = require("jsonwebtoken");
const request = require("supertest");

const paymentMockState = {
  verifyShouldPass: true,
  amountFetchOk: true,
  amountFetchAmountRupees: 0,
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
      if (!paymentMockState.amountFetchOk) return { ok: false, error: new Error("fetch failed") };
      return { ok: true, amountRupees: Number(paymentMockState.amountFetchAmountRupees), raw: {} };
    }),
    refundUpiPayment: jest.fn(async () => ({ ok: true, refund: { id: "rfnd_wallet_test_1" } })),
  };
});

jest.mock("../../src/services/redisLock.service", () => ({
  acquireLock: jest.fn(async () => ({ acquired: true, token: "lock_token_test", skipped: false })),
  releaseLock: jest.fn(async () => {}),
}));

const { createApp } = require("../../src/app");
const {
  seedBookingFixtures,
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");
const Booking = require("../../src/models/booking.model");
const Payment = require("../../src/models/payment.model");
const User = require("../../src/models/user.model");
const Admin = require("../../src/models/admin.model");

describe("wallet and payment security integration", () => {
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
    process.env.ENABLE_WALLET_BALANCE_GUARD = "true";
    delete process.env.REDIS_URL;
    paymentMockState.verifyShouldPass = true;
    paymentMockState.amountFetchOk = true;
    paymentMockState.amountFetchAmountRupees = 0;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Farmer with wallet 0 attempting advance payment gets 402", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 0 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    booking.advanceAmount = 500;
    booking.advancePayment = 500;
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_wallet_0" });

    expect(res.status).toBe(402);
    expect(res.body.message).toBe("Insufficient wallet balance");
  });

  test("Farmer with sufficient wallet pays and wallet is deducted", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 1000 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    booking.advanceAmount = 500;
    booking.advancePayment = 500;
    await booking.save();

    const before = await User.findById(farmer._id).select("wallet").lean();
    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_wallet_deduct_1" });

    expect(res.status).toBe(200);
    const after = await User.findById(farmer._id).select("wallet").lean();
    expect(after.wallet).toBe(Number(before.wallet) - 500);
  });

  test("Wallet cannot go below 0 (overdraw attempt is rejected)", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 100 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    booking.advanceAmount = 300;
    booking.advancePayment = 300;
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_wallet_overdraw" });

    expect(res.status).toBe(402);
    expect(res.body.message).toBe("Insufficient wallet balance");
  });

  test("Concurrent payment attempts do not over-deduct wallet", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 500 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    booking.advanceAmount = 500;
    booking.advancePayment = 500;
    await booking.save();

    const before = await User.findById(farmer._id).select("wallet").lean();
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ paymentMethod: "upi", transactionId: `txn_concurrent_1_${Date.now()}` }),
      request(app)
        .post(`/api/v1/bookings/${booking._id}/pay-advance`)
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ paymentMethod: "upi", transactionId: `txn_concurrent_2_${Date.now()}` }),
    ]);

    expect([r1.status, r2.status]).toContain(200);
    const after = await User.findById(farmer._id).select("wallet").lean();
    expect(after.wallet).toBe(Number(before.wallet) - 500);
    expect(await Payment.countDocuments({ bookingId: booking._id, type: "advance" })).toBe(1);
  });

  test("Payment amount mismatch vs booking amount is rejected with 400", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_PAYMENT = "false";
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 1000 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();
    paymentMockState.amountFetchAmountRupees = Number(booking.advanceAmount || 0) + 50;

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        paymentMethod: "upi",
        orderId: "order_amt_mismatch_security",
        paymentId: "pay_amt_mismatch_security",
        signature: "sig_amt_mismatch_security",
      });

    expect(res.status).toBe(400);
  });

  test("Duplicate payment attempt is idempotent and creates only one payment record", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 1000 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const first = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_dup_security_1" });
    const second = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_dup_security_1" });

    expect(first.status).toBe(200);
    // Current behavior is idempotent 200 for duplicate attempt instead of conflict.
    expect(second.status).toBe(200);
    expect(await Payment.countDocuments({ bookingId: booking._id, type: "advance" })).toBe(1);
  });

  test("Approved refund credits wallet by exact full amount", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 0 } });

    const admin = await Admin.create({
      name: "Admin Wallet Refund",
      email: "admin.wallet.refund@test.local",
      role: "admin",
      isActive: true,
    });
    const adminToken = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "cancelled";
    booking.cancelledBy = "operator";
    booking.refundStatus = "pending";
    booking.refundAmount = 500;
    booking.cancellationCharge = 0;
    await booking.save();

    await Payment.create({
      bookingId: booking._id,
      userId: farmer._id,
      amount: 500,
      type: "advance",
      status: "SUCCESS",
      paymentMethod: "upi",
      transactionId: "txn_wallet_refund_1",
      orderId: "order_wallet_refund_1",
      paymentId: "pay_wallet_refund_1",
      refundStatus: "none",
      walletDebitedAt: new Date(),
    });

    const before = await User.findById(farmer._id).select("wallet").lean();
    const res = await request(app)
      .post(`/api/v1/admin/refunds/${booking._id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve", refundReason: "wallet credit test" });

    expect(res.status).toBe(200);
    const after = await User.findById(farmer._id).select("wallet").lean();
    expect(after.wallet).toBe(Number(before.wallet) + 500);
  });

  // BACKLOG: partial refund wallet credit not yet implemented. Track as WALLET-002 before enabling partial refunds.
  test.skip("Partial refund credits only partial amount", async () => {
  });

  test("Payment on cancelled booking is rejected with 400", async () => {
    const { farmerToken, farmer, operator, tractor } = await seedBookingFixtures();
    await User.updateOne({ _id: farmer._id }, { $set: { wallet: 1000 } });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "cancelled";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_cancelled_security" });

    expect(res.status).toBe(400);
  });

  test("Farmer A cannot pay for Farmer B booking", async () => {
    const { farmerToken, operator, tractor } = await seedBookingFixtures();
    const farmerB = await User.create({
      name: "Farmer B",
      phone: "+919999900111",
      role: "farmer",
      landArea: 3,
      wallet: 1000,
    });
    const booking = await createPendingBookingForFarmer({
      farmerId: farmerB._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_cross_farmer" });

    expect(res.status).toBe(403);
  });

  test("Operator cannot trigger payment on behalf of farmer", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_due";
    await booking.save();

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/pay-advance`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ paymentMethod: "upi", transactionId: "txn_operator_forbidden" });

    expect(res.status).toBe(403);
  });
});
