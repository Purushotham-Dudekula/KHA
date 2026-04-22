const OperatorEarning = require("../../src/models/operatorEarning.model");
const LedgerTransaction = require("../../src/models/transaction.model");
const { logger } = require("../../src/utils/logger");
const {
  recordOperatorEarningFromSettlement,
  logPaymentSuccess,
  logRefundSuccess,
} = require("../../src/services/ledger.service");

jest.mock("../../src/utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn() },
}));

describe("ledger.service", () => {
  beforeEach(() => {
    jest.spyOn(OperatorEarning, "create").mockResolvedValue({});
    jest.spyOn(LedgerTransaction, "create").mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("recordOperatorEarningFromSettlement no-ops on missing booking", async () => {
    await recordOperatorEarningFromSettlement(null);
    expect(OperatorEarning.create).not.toHaveBeenCalled();
  });

  test("recordOperatorEarningFromSettlement skips duplicate key 11000", async () => {
    const err = new Error("dup");
    err.code = 11000;
    OperatorEarning.create.mockRejectedValueOnce(err);
    await recordOperatorEarningFromSettlement({
      _id: "507f1f77bcf86cd799439011",
      operator: "507f1f77bcf86cd799439012",
      totalAmount: 100,
      platformFee: 10,
      gstAmount: 0,
      operatorEarning: 50,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("recordOperatorEarningFromSettlement logs on other errors", async () => {
    OperatorEarning.create.mockRejectedValueOnce(new Error("boom"));
    await recordOperatorEarningFromSettlement({
      _id: "507f1f77bcf86cd799439011",
      operator: "507f1f77bcf86cd799439012",
      totalAmount: 100,
      platformFee: 10,
      gstAmount: 0,
      operatorEarning: 50,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  test("logPaymentSuccess skips empty ledgerKey", async () => {
    await logPaymentSuccess({ userId: "u", bookingId: "b", amount: 1, ledgerKey: "   " });
    expect(LedgerTransaction.create).not.toHaveBeenCalled();
  });

  test("logPaymentSuccess duplicate 11001 skips with info", async () => {
    const e = new Error("d");
    e.code = 11001;
    LedgerTransaction.create.mockRejectedValueOnce(e);
    await logPaymentSuccess({ userId: "u", bookingId: "b", amount: 1, ledgerKey: "k1" });
    expect(logger.info).toHaveBeenCalled();
  });

  test("logRefundSuccess duplicate 11000 skips", async () => {
    const e = new Error("d");
    e.code = 11000;
    LedgerTransaction.create.mockRejectedValueOnce(e);
    await logRefundSuccess({ userId: "u", bookingId: "b", amount: 2, ledgerKey: "k2" });
    expect(logger.info).toHaveBeenCalled();
  });

  test("logRefundSuccess other error warns", async () => {
    LedgerTransaction.create.mockRejectedValueOnce(new Error("x"));
    await logRefundSuccess({ userId: "u", bookingId: "b", amount: 2, ledgerKey: "k3" });
    expect(logger.warn).toHaveBeenCalled();
  });
});
