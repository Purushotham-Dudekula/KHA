const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { errorHandler } = require("../src/middleware/errorHandler");

jest.mock("../src/models/user.model", () => ({
  findById: jest.fn(),
}));

jest.mock("../src/services/redis.service", () => ({
  getRedisClient: jest.fn(() => null),
}));

const User = require("../src/models/user.model");

describe("middleware reliability", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      JWT_SECRET: "middleware-test-jwt-secret-32chars!!",
    };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("auth middleware returns 401 when token is missing", async () => {
    const { protect } = require("../src/middleware/auth.middleware");
    const app = express();
    app.get("/protected", protect, (_req, res) => res.status(200).json({ success: true }));
    app.use(errorHandler);

    const res = await request(app).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      message: "Unauthorized. Token missing.",
      errors: null,
    });
  });

  test("auth middleware returns 401 for invalid token", async () => {
    const { protect } = require("../src/middleware/auth.middleware");
    const app = express();
    app.get("/protected", protect, (_req, res) => res.status(200).json({ success: true }));
    app.use(errorHandler);

    const res = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer invalid.token.value");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      message: "Unauthorized. Invalid or expired token.",
      errors: null,
    });
  });

  test("rate limiter returns 429 after limit exceeded", async () => {
    const { buildLimiter } = require("../src/middleware/rateLimit.middleware");
    const app = express();
    app.use(
      buildLimiter({
        windowMs: 60_000,
        maxAuthenticated: 1,
        maxUnauthenticated: 1,
        message: "Too many requests for test",
      })
    );
    app.get("/limited", (_req, res) => res.status(200).json({ success: true }));
    app.use(errorHandler);

    const first = await request(app).get("/limited");
    const second = await request(app).get("/limited");

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({
      success: false,
      message: "Too many requests for test",
    });
  });

  test("db connection middleware returns 503 when disconnected in production", async () => {
    const { mongoConnectionSafety } = require("../src/middleware/mongoConnectionSafety.middleware");
    const app = express();
    const originalReadyState = mongoose.connection.readyState;
    process.env.NODE_ENV = "production";
    mongoose.connection.readyState = 0;

    app.get("/db-check", mongoConnectionSafety(), (_req, res) => {
      res.status(200).json({ success: true });
    });

    const res = await request(app).get("/db-check");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      message: "Database unavailable",
    });

    mongoose.connection.readyState = originalReadyState;
  });

  test("request timeout middleware returns 408 for long request", async () => {
    const { requestTimeout } = require("../src/middleware/requestTimeout.middleware");
    const app = express();

    app.get("/slow", requestTimeout(20), async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (!res.headersSent) {
        res.status(200).json({ success: true });
      }
    });
    app.use(errorHandler);

    const res = await request(app).get("/slow");

    expect(res.status).toBe(408);
    expect(res.body).toEqual({
      success: false,
      message: "Request timeout.",
    });
  });

  test("admin access middleware returns 403 for non-admin role", async () => {
    const { requireAdmin } = require("../src/middleware/admin.middleware");
    const app = express();

    app.get(
      "/admin-only",
      (req, _res, next) => {
        req.admin = { _id: "507f1f77bcf86cd799439011", role: "farmer" };
        next();
      },
      requireAdmin,
      (_req, res) => res.status(200).json({ success: true })
    );
    app.use(errorHandler);

    const res = await request(app).get("/admin-only");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      message: "Admin access required",
      errors: null,
    });
  });

  test("auth middleware returns 403 for blocked user", async () => {
    const { protect } = require("../src/middleware/auth.middleware");
    const token = jwt.sign(
      { id: "507f1f77bcf86cd799439011" },
      process.env.JWT_SECRET,
      { expiresIn: "5m" }
    );
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        role: "farmer",
        isBlocked: true,
      }),
    });

    const app = express();
    app.get("/protected", protect, (_req, res) => res.status(200).json({ success: true }));
    app.use(errorHandler);

    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      message: "User is blocked",
      errors: null,
    });
  });
});
