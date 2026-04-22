const mongoose = require("mongoose");
const Booking = require("../../src/models/booking.model");
const Commission = require("../../src/models/commission.model");
const { applyBookingSettlementAfterFullPayment, isFullPaymentSettled } = require("../../src/services/bookingSettlement.service");

jest.mock("../../src/services/ledger.service", () => ({
  recordOperatorEarningFromSettlement: jest.fn().mockResolvedValue(),
}));

describe("bookingSettlement.service", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("isFullPaymentSettled requires closed status and paid-like paymentStatus", () => {
    expect(isFullPaymentSettled({ status: "closed", paymentStatus: "fully_paid" })).toBe(true);
    expect(isFullPaymentSettled({ status: "closed", paymentStatus: "paid" })).toBe(true);
    expect(isFullPaymentSettled({ status: "completed", paymentStatus: "fully_paid" })).toBe(false);
  });

  test("applyBookingSettlementAfterFullPayment returns not_settled when booking not closed+paid", async () => {
    jest.spyOn(Booking, "findById").mockResolvedValue({
      status: "completed",
      paymentStatus: "balance_due",
    });
    const out = await applyBookingSettlementAfterFullPayment(new mongoose.Types.ObjectId());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_settled");
  });

  test("applyBookingSettlementAfterFullPayment applies when settled and commission exists", async () => {
    const id = new mongoose.Types.ObjectId();
    const save = jest.fn().mockResolvedValue();
    jest.spyOn(Booking, "findById").mockResolvedValue({
      _id: id,
      status: "closed",
      paymentStatus: "fully_paid",
      totalAmount: 1000,
      save,
    });
    jest.spyOn(Commission, "findOne").mockReturnValue({
      sort: () => ({ lean: async () => ({ percentage: 10 }) }),
    });

    const out = await applyBookingSettlementAfterFullPayment(id);
    expect(out.ok).toBe(true);
    expect(save).toHaveBeenCalled();
  });
});
