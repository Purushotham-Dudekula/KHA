jest.mock("../../../src/config/env", () => ({
  env: { devRouteSecret: "dev-secret-xyz" },
}));

const { requireDevelopmentOnly } = require("../../../src/middleware/devOnly.middleware");

describe("devOnly.middleware requireDevelopmentOnly", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("blocks when NODE_ENV is not development", () => {
    process.env.NODE_ENV = "production";
    const res = { status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    requireDevelopmentOnly(
      { headers: { "x-dev-secret": "dev-secret-xyz" } },
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Forbidden." }));
  });

  test("blocks when secret header does not match", () => {
    process.env.NODE_ENV = "development";
    const res = { status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    requireDevelopmentOnly({ headers: { "x-dev-secret": "wrong" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test("allows when NODE_ENV is development and secret matches", () => {
    process.env.NODE_ENV = "development";
    const res = { status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    requireDevelopmentOnly({ headers: { "x-dev-secret": "dev-secret-xyz" } }, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
