const mongoose = require("mongoose");
const { mongoConnectionSafety } = require("../../../src/middleware/mongoConnectionSafety.middleware");

describe("mongoConnectionSafety.middleware", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalReadyState = mongoose.connection.readyState;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    Object.defineProperty(mongoose.connection, "readyState", {
      value: originalReadyState,
      configurable: true,
    });
  });

  test("non-production always calls next()", () => {
    process.env.NODE_ENV = "test";
    const mw = mongoConnectionSafety();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/bookings" }, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("production + health path calls next()", () => {
    process.env.NODE_ENV = "production";
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    const mw = mongoConnectionSafety();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/health" }, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("production + connected mongoose calls next()", () => {
    process.env.NODE_ENV = "production";
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    const mw = mongoConnectionSafety();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mw({ path: "/api/v1/bookings" }, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("production + disconnected returns 503 for non-health", () => {
    process.env.NODE_ENV = "production";
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    const mw = mongoConnectionSafety();
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
