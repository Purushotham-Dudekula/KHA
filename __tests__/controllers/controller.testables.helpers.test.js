const { AppError } = require("../../src/utils/AppError");

describe("booking.controller __testables", () => {
  const bookingCtrl = require("../../src/controllers/booking/booking.index.js");
  const t = bookingCtrl.__testables;

  test("isPaidLikePaymentStatus true/false branches", () => {
    expect(t.isPaidLikePaymentStatus("fully_paid")).toBe(true);
    expect(t.isPaidLikePaymentStatus("paid")).toBe(true);
    expect(t.isPaidLikePaymentStatus("advance_paid")).toBe(false);
  });

  test("parsePagination clamps page/limit", () => {
    expect(t.parsePagination({ page: "0", limit: "1000" })).toEqual({ page: 1, limit: 50, skip: 0 });
    expect(t.parsePagination({ page: "2", limit: "10" })).toEqual({ page: 2, limit: 10, skip: 10 });
  });

  test("duplicate-key detectors detect farmer and slot patterns", () => {
    expect(
      t.isFarmerActiveBookingDuplicateKey({
        code: 11000,
        keyPattern: { farmer: 1 },
      })
    ).toBe(true);

    expect(
      t.isMachineSlotBookingDuplicateKey({
        code: 11000,
        keyValue: { tractor: "t1", date: "d1", time: "10:00" },
      })
    ).toBe(true);

    expect(t.isMachineSlotBookingDuplicateKey(new Error("other"))).toBe(false);
  });

  test("assert helpers throw AppError for invalid states", () => {
    expect(() => t.assertNotActionBlocked({ status: "cancelled" })).toThrow(AppError);
    expect(() => t.assertPaymentNotTerminal({ status: "rejected" })).toThrow(AppError);
    expect(() => t.assertStatus({ status: "pending" }, ["accepted"], "x")).toThrow(AppError);
    expect(() => t.assertPaymentStatus({ paymentStatus: "no_payment" }, ["advance_paid"], "x")).toThrow(
      AppError
    );
    expect(() => t.assertBookingTransition("pending", "closed", "x")).toThrow(AppError);
  });

  test("withStatusMessage handles plain object and null", () => {
    expect(t.withStatusMessage(null)).toBeNull();
    const out = t.withStatusMessage({ status: "pending", x: 1 });
    expect(out.statusMessage).toBeDefined();
    expect(out.x).toBe(1);
  });
});

describe("admin.controller __testables", () => {
  const adminCtrl = require("../../src/controllers/admin/admin.index.js");
  const t = adminCtrl.__testables;

  test("parsePagination clamps and computes skip", () => {
    expect(t.parsePagination({ page: "0", limit: "-1" })).toEqual({ page: 1, limit: 1, skip: 0 });
    expect(t.parsePagination({ page: "3", limit: "25" })).toEqual({ page: 3, limit: 25, skip: 50 });
  });

  test("adminPublic strips password and maps fields", () => {
    const input = {
      toObject: () => ({
        _id: "a1",
        name: "Admin",
        email: "a@x.com",
        role: "admin",
        isActive: true,
        password: "secret",
        createdAt: "c",
        updatedAt: "u",
      }),
    };
    const out = t.adminPublic(input);
    expect(out.id).toBe("a1");
    expect(out.password).toBeUndefined();
  });

  test("shouldIncludeDemandLocations handles bool/string branches", () => {
    expect(t.shouldIncludeDemandLocations(true)).toBe(true);
    expect(t.shouldIncludeDemandLocations("true")).toBe(true);
    expect(t.shouldIncludeDemandLocations("1")).toBe(true);
    expect(t.shouldIncludeDemandLocations("false")).toBe(false);
    expect(t.shouldIncludeDemandLocations(undefined)).toBe(false);
  });
});
