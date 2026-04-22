const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../src/app");
const authRouter = require("../../src/routes/auth.routes");
const User = require("../../src/models/user.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("security regressions: logout protections", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    process.env.JWT_SECRET = process.env.JWT_SECRET || "testsecret";
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("logout route keeps auth middleware attached", () => {
    const layer = authRouter.stack.find((entry) => entry?.route?.path === "/logout");
    expect(layer).toBeDefined();
    const middlewareNames = layer.route.stack.map((s) => s.name);
    expect(middlewareNames).toContain("protect");
  });

  test("unauthorized logout request returns 401", async () => {
    const res = await request(app).post("/api/v1/auth/logout").send({});
    expect(res.status).toBe(401);
  });

  test("authenticated user A cannot logout user B", async () => {
    const userA = await User.create({
      phone: "9999000011",
      refreshTokenHash: "hash-a",
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const userB = await User.create({
      phone: "9999000022",
      refreshTokenHash: "hash-b",
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const tokenA = jwt.sign({ id: String(userA._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ userId: String(userB._id) });

    expect(res.status).toBe(200);

    const freshA = await User.findById(userA._id).select("+refreshTokenHash +refreshTokenExpiresAt");
    const freshB = await User.findById(userB._id).select("+refreshTokenHash +refreshTokenExpiresAt");
    expect(freshA.refreshTokenHash).toBeNull();
    expect(freshA.refreshTokenExpiresAt).toBeNull();
    expect(freshB.refreshTokenHash).toBe("hash-b");
    expect(freshB.refreshTokenExpiresAt).toBeTruthy();
  });
});
