/**
 * metrics.middleware — mock prom-client. Call metricsMiddleware() once when enabled (prom-client registers names globally).
 */
jest.mock("prom-client", () => {
  const inc = jest.fn();
  const observe = jest.fn();
  return {
    register: {
      contentType: "text/plain; version=0.0.4",
      metrics: jest.fn().mockResolvedValue("# metrics"),
    },
    collectDefaultMetrics: jest.fn(),
    Counter: jest.fn(() => ({ inc })),
    Histogram: jest.fn(() => ({ observe })),
    __test: { inc, observe },
  };
});

const { EventEmitter } = require("events");
const promClient = require("prom-client");
const { inc, observe } = promClient.__test;

describe("metrics.middleware (enabled)", () => {
  const originalMetrics = process.env.ENABLE_METRICS;
  let middleware;
  let handler;

  beforeAll(() => {
    process.env.ENABLE_METRICS = "true";
    const { metricsMiddleware } = require("../../../src/middleware/metrics.middleware");
    ({ middleware, handler } = metricsMiddleware());
  });

  afterAll(() => {
    process.env.ENABLE_METRICS = originalMetrics;
  });

  beforeEach(() => {
    inc.mockClear();
    observe.mockClear();
  });

  test("on response finish, records request count and duration", () => {
    const req = { method: "POST", path: "/api/v1/x", route: { path: "/api/v1/x" } };
    const res = new EventEmitter();
    res.statusCode = 201;
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
    res.emit("finish");

    expect(inc).toHaveBeenCalledWith({
      method: "POST",
      route: "/api/v1/x",
      status: "201",
    });
    expect(observe).toHaveBeenCalledWith(
      { method: "POST", route: "/api/v1/x", status: "201" },
      expect.any(Number)
    );
  });

  test("uses req.path when req.route missing and records error status codes", () => {
    const req = { method: "GET", path: "/fallback", route: undefined };
    const res = new EventEmitter();
    res.statusCode = 500;
    const next = jest.fn();
    middleware(req, res, next);
    res.emit("finish");
    expect(inc).toHaveBeenCalledWith({
      method: "GET",
      route: "/fallback",
      status: "500",
    });
  });

  test("handler exposes scraped metrics", async () => {
    const res = { setHeader: jest.fn(), end: jest.fn() };
    await handler({}, res);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", promClient.register.contentType);
    expect(res.end).toHaveBeenCalledWith(await promClient.register.metrics());
  });
});

describe("metrics.middleware (disabled)", () => {
  const originalMetrics = process.env.ENABLE_METRICS;

  afterEach(() => {
    process.env.ENABLE_METRICS = originalMetrics;
  });

  test("when ENABLE_METRICS is false, middleware only calls next()", () => {
    jest.resetModules();
    process.env.ENABLE_METRICS = "false";
    const { metricsMiddleware } = require("../../../src/middleware/metrics.middleware");
    const { middleware } = metricsMiddleware();
    const next = jest.fn();
    middleware({ method: "GET", path: "/" }, { on: jest.fn() }, next);
    expect(next).toHaveBeenCalledWith();
  });
});
