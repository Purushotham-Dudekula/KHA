jest.mock("../../src/models/booking.model", () => ({ aggregate: jest.fn() }));
jest.mock("../../src/models/payment.model", () => ({
  aggregate: jest.fn(),
  findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
}));
jest.mock("../../src/models/user.model", () => ({ aggregate: jest.fn() }));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));

const Booking = require("../../src/models/booking.model");
const Payment = require("../../src/models/payment.model");
const User = require("../../src/models/user.model");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe("adminDashboard.controller (unit)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("getAdminDashboardBookingStats -> 200 success", async () => {
    const { getAdminDashboardBookingStats } = require("../../src/controllers/adminDashboard.controller");
    Booking.aggregate.mockResolvedValueOnce([{ totalBookings: 5, pending: 1, accepted: 2, completed: 1, cancelled: 1 }]);
    const res = makeRes();
    const next = jest.fn();
    await getAdminDashboardBookingStats({}, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("getAdminDashboardBookingStats -> 500 forwards error", async () => {
    const { getAdminDashboardBookingStats } = require("../../src/controllers/adminDashboard.controller");
    const err = new Error("db");
    Booking.aggregate.mockRejectedValueOnce(err);
    const next = jest.fn();
    await getAdminDashboardBookingStats({}, makeRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });

  test("getAdminDashboardRevenueStats -> 200 success (defaults)", async () => {
    const { getAdminDashboardRevenueStats } = require("../../src/controllers/adminDashboard.controller");
    Payment.aggregate.mockResolvedValueOnce([]);
    const res = makeRes();
    const next = jest.fn();
    await getAdminDashboardRevenueStats({}, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("getAdminDashboardUserStats -> 200 success", async () => {
    const { getAdminDashboardUserStats } = require("../../src/controllers/adminDashboard.controller");
    User.aggregate.mockResolvedValueOnce([{ totalFarmers: 2, totalOperators: 3 }]);
    const res = makeRes();
    await getAdminDashboardUserStats({}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

