jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));
jest.mock("../../src/utils/apiResponse", () => ({
  sendSuccess: jest.fn((res, status, _msg, data) => res.status(status).json({ success: true, data })),
}));

const User = require("../../src/models/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() };
}

describe("auth.controller audit high-impact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = "testsecret";
  });

  test("refreshToken returns 401 when cookie missing", async () => {
    const { refreshToken } = require("../../src/controllers/auth.controller");
    const next = jest.fn();
    await refreshToken({ headers: {}, body: { userId: "507f1f77bcf86cd799439011" } }, makeRes(), next);
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(String(err.message)).toMatch(/Refresh token missing/i);
  });

  test("refreshToken returns 401 when refresh token is invalid", async () => {
    const { refreshToken } = require("../../src/controllers/auth.controller");
    const next = jest.fn();
    await refreshToken({ headers: { cookie: "refreshToken=abc" }, body: { userId: "bad" } }, makeRes(), next);
    const err = next.mock.calls[0][0];
    expect(String(err.message)).toMatch(/Refresh token invalid/i);
  });

  test("refreshToken expires old token and returns 401", async () => {
    const { refreshToken } = require("../../src/controllers/auth.controller");
    User.findById.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        refreshTokenHash: "h",
        refreshTokenExpiresAt: new Date(Date.now() - 1000),
      }),
    });
    const next = jest.fn();
    const refresh = jwt.sign({ id: "507f1f77bcf86cd799439011" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    await refreshToken({ headers: { cookie: `refreshToken=${refresh}` }, body: {} }, makeRes(), next);
    expect(User.updateOne).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(String(err.message)).toMatch(/expired/i);
  });

  test("refreshToken rotates token on valid cookie", async () => {
    const { refreshToken } = require("../../src/controllers/auth.controller");
    User.findById.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        refreshTokenHash: "h",
        refreshTokenExpiresAt: new Date(Date.now() + 3600_000),
      }),
    });
    bcrypt.compare.mockResolvedValueOnce(true);
    bcrypt.hash.mockResolvedValueOnce("new_hash");
    const res = makeRes();
    const refresh = jwt.sign({ id: "507f1f77bcf86cd799439011" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    await refreshToken({ headers: { cookie: `refreshToken=${refresh}` }, body: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.cookie).toHaveBeenCalled();
  });
});

