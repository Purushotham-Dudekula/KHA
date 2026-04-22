/**
 * errorHandler invokes logger.error for handled errors; verify with mocked logger.
 */
const { errorHandler } = require("../../src/middleware/errorHandler");
const { logger } = require("../../src/utils/logger");

describe("errorHandler + logger", () => {
  const originalError = logger.error;

  afterEach(() => {
    logger.error = originalError;
    jest.restoreAllMocks();
  });

  test("logger.error called when handling an Error", () => {
    const spy = jest.fn();
    logger.error = spy;

    const err = new Error("unit test failure");
    const req = { originalUrl: "/test", method: "GET", requestId: "req-1" };
    const res = {
      statusCode: 500,
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    errorHandler(err, req, res, jest.fn());

    expect(spy).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      })
    );
  });

  test("AppError maps to statusCode and logger.error still runs", () => {
    const { AppError } = require("../../src/utils/AppError");
    const spy = jest.fn();
    logger.error = spy;

    const err = new AppError("not found", 404);
    const req = { originalUrl: "/x", method: "GET" };
    const res = {
      statusCode: 200,
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    errorHandler(err, req, res, jest.fn());

    expect(spy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
