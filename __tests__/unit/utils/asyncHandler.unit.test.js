const { asyncHandler } = require("../../../src/utils/asyncHandler");

describe("asyncHandler", () => {
  test("forwards resolved handler result", async () => {
    const fn = asyncHandler(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const req = {};
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await fn(req, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("passes rejection to next", async () => {
    const err = new Error("fail");
    const fn = asyncHandler(async () => {
      throw err;
    });
    const next = jest.fn();
    await fn({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
