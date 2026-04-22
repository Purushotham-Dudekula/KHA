const mongoose = require("mongoose");
const { requireDbConnection } = require("../../../src/middleware/dbAvailability.middleware");

describe("dbAvailability.middleware requireDbConnection", () => {
  const originalReadyState = mongoose.connection.readyState;

  afterEach(() => {
    Object.defineProperty(mongoose.connection, "readyState", {
      value: originalReadyState,
      configurable: true,
    });
  });

  test("health paths call next() without checking DB", () => {
    const mw = requireDbConnection();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/health" }, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("v1 health path calls next()", () => {
    const mw = requireDbConnection();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/health" }, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("when Mongo connected (1) calls next()", () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    const mw = requireDbConnection();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/bookings" }, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("when Mongo connecting (2) calls next()", () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 2, configurable: true });
    const mw = requireDbConnection();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/bookings" }, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("when Mongo disconnected returns 503", () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    const mw = requireDbConnection();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/bookings" }, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Database unavailable",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
