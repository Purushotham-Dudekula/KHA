describe("redis.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("getRedisClient -> null in test env", () => {
    process.env.NODE_ENV = "test";
    const { getRedisClient } = require("../../../src/services/redis.service");
    expect(getRedisClient()).toBeNull();
  });

  test("getRedisClient -> null when disabled", () => {
    process.env.NODE_ENV = "development";
    process.env.REDIS_DISABLED = "true";
    const { getRedisClient } = require("../../../src/services/redis.service");
    expect(getRedisClient()).toBeNull();
  });

  test("connectRedisOrThrow -> throws in production when REDIS_URL missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_DISABLED;
    delete process.env.REDIS_URL;
    const { connectRedisOrThrow } = require("../../../src/services/redis.service");
    await expect(connectRedisOrThrow()).rejects.toThrow(/REDIS_URL is required/i);
  });

  test("connectRedisOrThrow -> non-prod returns null if connect fails", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_DISABLED;
    process.env.REDIS_URL = "redis://localhost:6379";
    jest.doMock("ioredis", () => {
      return function Redis() {
        return {
          status: "end",
          on: jest.fn(),
          connect: jest.fn().mockRejectedValueOnce(new Error("nope")),
        };
      };
    });
    const { connectRedisOrThrow } = require("../../../src/services/redis.service");
    const c = await connectRedisOrThrow();
    expect(c).toBeNull();
  });

  test("connectRedisOrThrow -> returns client when ping ok", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_DISABLED;
    process.env.REDIS_URL = "redis://localhost:6379";
    const client = {
      status: "end",
      on: jest.fn(),
      connect: jest.fn(async () => {}),
      ping: jest.fn(async () => "PONG"),
    };
    jest.doMock("ioredis", () => {
      return function Redis() {
        return client;
      };
    });
    const { connectRedisOrThrow, getRedisClient } = require("../../../src/services/redis.service");
    const c = await connectRedisOrThrow();
    expect(c).toBe(client);
    expect(getRedisClient()).toBe(client);
  });

  test("getRedisHealth -> reflects configured/connected flags", () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_DISABLED;
    process.env.REDIS_URL = "redis://x";
    const { getRedisHealth } = require("../../../src/services/redis.service");
    const h = getRedisHealth();
    expect(h.configured).toBe(true);
    expect(h.connected).toBe(false);
  });
});

