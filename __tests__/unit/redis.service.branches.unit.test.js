describe("redis.service branches", () => {
  const base = { ...process.env };

  afterEach(() => {
    process.env = { ...base };
    jest.resetModules();
  });

  test("getRedisClient returns null in test env", () => {
    process.env.NODE_ENV = "test";
    const { getRedisClient } = require("../../src/services/redis.service");
    expect(getRedisClient()).toBeNull();
  });

  test("getRedisClient returns null when REDIS_DISABLED", () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = "development";
      process.env.REDIS_DISABLED = "true";
      delete process.env.REDIS_URL;
      const { getRedisClient } = require("../../src/services/redis.service");
      expect(getRedisClient()).toBeNull();
    });
  });

  test("connectRedisOrThrow returns null in development without REDIS_URL", async () => {
    jest.isolateModules(async () => {
      process.env.NODE_ENV = "development";
      process.env.REDIS_DISABLED = "false";
      delete process.env.REDIS_URL;
      const { connectRedisOrThrow } = require("../../src/services/redis.service");
      await expect(connectRedisOrThrow()).resolves.toBeNull();
    });
  });

  test("getRedisHealth reflects disabled test mode", () => {
    process.env.NODE_ENV = "test";
    const { getRedisHealth } = require("../../src/services/redis.service");
    const h = getRedisHealth();
    expect(h.configured).toBe(false);
    expect(h.connected).toBe(false);
  });
});
