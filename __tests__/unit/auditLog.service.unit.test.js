jest.mock("../../src/models/auditLog.model", () => ({
  create: jest.fn(),
}));

const AuditLog = require("../../src/models/auditLog.model");
const { logger } = require("../../src/utils/logger");
const { logAuditAction } = require("../../src/services/auditLog.service");

describe("auditLog.service", () => {
  beforeEach(() => {
    AuditLog.create.mockReset();
  });

  test("no-ops when action is empty", async () => {
    await logAuditAction("507f1f77bcf86cd799439011", "");
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test("creates audit row with valid userId", async () => {
    AuditLog.create.mockResolvedValue({});
    await logAuditAction("507f1f77bcf86cd799439011", " login ");
    expect(AuditLog.create).toHaveBeenCalledWith({
      userId: "507f1f77bcf86cd799439011",
      action: "login",
    });
  });

  test("stores null userId when id invalid", async () => {
    AuditLog.create.mockResolvedValue({});
    await logAuditAction("not-an-id", "action");
    expect(AuditLog.create).toHaveBeenCalledWith({
      userId: null,
      action: "action",
    });
  });

  test("swallows DB errors and logs warning", async () => {
    AuditLog.create.mockRejectedValue(new Error("econn"));
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    await logAuditAction("507f1f77bcf86cd799439011", "x");
    expect(logger.warn).toHaveBeenCalledWith("Audit log write failed", { message: "econn" });
  });
});
