jest.mock("../../src/models/admin.model", () => ({
  exists: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/models/tractor.model", () => ({ findById: jest.fn() }));
jest.mock("../../src/models/booking.model", () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock("../../src/models/complaint.model", () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock("../../src/models/payment.model", () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock("../../src/models/pricing.model", () => ({ findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock("../../src/models/commission.model", () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock("../../src/models/seasonalPricing.model", () => ({ find: jest.fn(), findOneAndUpdate: jest.fn(), findByIdAndDelete: jest.fn() }));
jest.mock("../../src/models/adminAuditLog.model", () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock("../../src/models/adminActivityLog.model", () => ({ find: jest.fn(), countDocuments: jest.fn() }));

jest.mock("../../src/services/adminAuditLog.service", () => ({ logAdminAction: jest.fn() }));
jest.mock("../../src/services/adminActivityLog.service", () => ({ logAdminActivity: jest.fn() }));
jest.mock("../../src/services/auditLog.service", () => ({ logAuditAction: jest.fn() }));
jest.mock("../../src/services/notification.service", () => ({ notifyUser: jest.fn() }));
jest.mock("../../src/services/payment.service", () => ({ refundUpiPayment: jest.fn() }));
jest.mock("../../src/services/ledger.service", () => ({ logRefundSuccess: jest.fn() }));
jest.mock("../../src/utils/refundCalculation", () => ({ resolveRefundSnapshot: jest.fn() }));
jest.mock("../../src/services/storage.service", () => ({ getSecureFileUrl: jest.fn() }));
jest.mock("../../src/middleware/auth.middleware", () => ({ invalidateUserAuthCache: jest.fn() }));
jest.mock("../../src/utils/verification", () => ({
  hasOperatorDocumentsForApproval: jest.fn(() => false),
  validateTractorForApproval: jest.fn(() => ({ ok: false, missing: ["rcDocument"] })),
  deriveTractorVerificationFromDocuments: jest.fn(() => ({ verificationStatus: "pending", documentsVerified: false })),
}));
jest.mock("../../src/utils/cleanUserResponse", () => ({ cleanUserResponse: jest.fn((u) => u) }));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));
jest.mock("../../src/utils/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const Admin = require("../../src/models/admin.model");
const User = require("../../src/models/user.model");
const Tractor = require("../../src/models/tractor.model");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("admin.controller aggressive", () => {
  beforeEach(() => jest.clearAllMocks());

  test("createAdmin branches 400/409/201/500", async () => {
    const { createAdmin } = require("../../src/controllers/admin/admin.index.js");
    await createAdmin({ body: {}, admin: { _id: "a1" } }, makeRes(), jest.fn()); //400
    Admin.exists.mockResolvedValueOnce(true);
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //409
    Admin.exists.mockResolvedValueOnce(false);
    Admin.create.mockResolvedValueOnce({ _id: "x", role: "admin", isActive: true, toObject: () => ({ _id: "x" }) });
    const res = makeRes();
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, res, jest.fn()); //201
    expect(res.status).toHaveBeenCalledWith(201);
    Admin.exists.mockResolvedValueOnce(false);
    Admin.create.mockRejectedValueOnce(new Error("db"));
    await createAdmin({ body: { name: "n", email: "a@b.com" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //500 next
  });

  test("bootstrapSuperAdmin branches", async () => {
    const { bootstrapSuperAdmin } = require("../../src/controllers/admin/admin.index.js");
    Admin.exists.mockResolvedValueOnce(true);
    await bootstrapSuperAdmin({ body: {} }, makeRes(), jest.fn()); //409
    Admin.exists.mockResolvedValueOnce(false);
    await bootstrapSuperAdmin({ body: {} }, makeRes(), jest.fn()); //400 name
    Admin.exists.mockResolvedValueOnce(false);
    Admin.create.mockResolvedValueOnce({ _id: "x", toObject: () => ({ _id: "x" }) });
    const res = makeRes();
    await bootstrapSuperAdmin({ body: { name: "n", email: "a@b.com" } }, res, jest.fn()); //201
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test("deactivateAdmin branches 400/404/403/200", async () => {
    const { deactivateAdmin } = require("../../src/controllers/admin/admin.index.js");
    await deactivateAdmin({ params: { id: "bad" }, admin: { _id: "a1" } }, makeRes(), jest.fn());
    Admin.findById.mockResolvedValueOnce(null);
    await deactivateAdmin({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, makeRes(), jest.fn());
    Admin.findById.mockResolvedValueOnce({ role: "super_admin" });
    await deactivateAdmin({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, makeRes(), jest.fn());
    const target = {
      _id: { equals: () => false, toString: () => "x" },
      role: "admin",
      isActive: true,
      save: jest.fn(async () => {}),
      toObject: () => ({ _id: "x" }),
    };
    Admin.findById.mockResolvedValueOnce(target);
    const res = makeRes();
    await deactivateAdmin({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("verify/reject operator and tractor branches", async () => {
    const c = require("../../src/controllers/admin/admin.index.js");
    await c.verifyOperator({ params: { id: "bad" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //400
    User.findById.mockResolvedValueOnce(null);
    await c.verifyOperator({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //404

    await c.rejectOperator({ params: { id: "bad" }, body: {}, admin: { _id: "a1" } }, makeRes(), jest.fn()); //400
    User.findById.mockResolvedValueOnce({ _id: "u1", role: "operator", save: jest.fn(async () => {}) });
    const res1 = makeRes();
    await c.rejectOperator({ params: { id: "507f1f77bcf86cd799439011" }, body: { reason: "r" }, admin: { _id: "a1" } }, res1, jest.fn()); //200
    expect(res1.status).toHaveBeenCalledWith(200);

    await c.verifyTractor({ params: { id: "bad" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //400
    Tractor.findById.mockResolvedValueOnce(null);
    await c.verifyTractor({ params: { id: "507f1f77bcf86cd799439011" }, admin: { _id: "a1" } }, makeRes(), jest.fn()); //404

    await c.rejectTractor({ params: { id: "bad" }, body: {}, admin: { _id: "a1" } }, makeRes(), jest.fn()); //400
    Tractor.findById.mockResolvedValueOnce({ _id: "t1", save: jest.fn(async () => {}) });
    const res2 = makeRes();
    await c.rejectTractor({ params: { id: "507f1f77bcf86cd799439011" }, body: { reason: "x" }, admin: { _id: "a1" } }, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(200);
  });

  test("list/admin profile functions smoke success+error", async () => {
    const c = require("../../src/controllers/admin/admin.index.js");
    Admin.countDocuments.mockResolvedValueOnce(0);
    Admin.find.mockReturnValueOnce({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) }) });
    await c.listAdmins({ query: {} }, makeRes(), jest.fn()); //200

    // Generic smoke for remaining exports to exercise try/catch and early returns
    for (const [name, fn] of Object.entries(c)) {
      if (typeof fn !== "function") continue;
      await fn(
        {
          params: { id: "bad", userId: "bad", bookingId: "bad", tractorId: "bad", complaintId: "bad" },
          query: {},
          body: {},
          user: { _id: "u1", role: "farmer" },
          admin: { _id: "a1", role: "admin" },
        },
        makeRes(),
        jest.fn()
      );
    }
  });
});

