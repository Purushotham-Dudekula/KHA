const { requireAdmin, requireSuperAdmin } = require("../../../src/middleware/admin.middleware");

describe("admin.middleware", () => {
  const res = () => ({ status: jest.fn().mockReturnThis() });

  test("requireAdmin returns 401 when req.admin missing", () => {
    const r = res();
    const next = jest.fn();
    requireAdmin({}, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Unauthorized" }));
  });

  test("requireAdmin returns 403 when role is not admin", () => {
    const r = res();
    const next = jest.fn();
    requireAdmin({ admin: { role: "viewer" } }, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Admin access required" }));
  });

  test("requireAdmin calls next for admin role", () => {
    const r = res();
    const next = jest.fn();
    requireAdmin({ admin: { role: "admin" } }, r, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("requireAdmin calls next for super_admin role", () => {
    const r = res();
    const next = jest.fn();
    requireAdmin({ admin: { role: "super_admin" } }, r, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("requireSuperAdmin returns 403 when role is admin only", () => {
    const r = res();
    const next = jest.fn();
    requireSuperAdmin({ admin: { role: "admin" } }, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Super admin access required" }));
  });

  test("requireSuperAdmin passes for super_admin", () => {
    const r = res();
    const next = jest.fn();
    requireSuperAdmin({ admin: { role: "super_admin" } }, r, next);
    expect(next).toHaveBeenCalledWith();
  });
});
