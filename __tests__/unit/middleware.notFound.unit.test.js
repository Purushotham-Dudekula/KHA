/**
 * notFound middleware — 404 JSON shape.
 */
const { notFound } = require("../../src/middleware/errorHandler");

describe("notFound middleware", () => {
  test("returns 404 with route message", () => {
    const req = { method: "GET", originalUrl: "/api/v1/missing" };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    notFound(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining("Route not found"),
      })
    );
  });
});
