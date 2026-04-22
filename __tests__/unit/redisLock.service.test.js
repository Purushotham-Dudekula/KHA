jest.mock("../../src/services/redis.service", () => ({
  getRedisClient: jest.fn(),
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { getRedisClient } = require("../../src/services/redis.service");
const { logger } = require("../../src/utils/logger");
const { acquireLock } = require("../../src/services/redisLock.service");

describe("redisLock.service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("acquireLock returns acquired=true when redis set succeeds", async () => {
    process.env.NODE_ENV = "development";
    const redis = {
      set: jest.fn().mockResolvedValue("OK"),
    };
    getRedisClient.mockReturnValue(redis);

    const out = await acquireLock("booking:123", 500);

    expect(redis.set).toHaveBeenCalledWith(
      "booking:123",
      expect.any(String),
      "PX",
      1000,
      "NX"
    );
    expect(out).toMatchObject({
      acquired: true,
      skipped: false,
    });
    expect(out.token).toEqual(expect.any(String));
  });

  test("acquireLock returns acquired=false when redis lock already exists", async () => {
    process.env.NODE_ENV = "development";
    const redis = {
      set: jest.fn().mockResolvedValue(null),
    };
    getRedisClient.mockReturnValue(redis);

    const out = await acquireLock("booking:123", 5000);

    expect(redis.set).toHaveBeenCalledWith(
      "booking:123",
      expect.any(String),
      "PX",
      5000,
      "NX"
    );
    expect(out).toMatchObject({
      acquired: false,
      skipped: false,
    });
    expect(out.token).toEqual(expect.any(String));
  });

  test("acquireLock falls back when redis throws in non-production", async () => {
    process.env.NODE_ENV = "development";
    const redis = {
      set: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    getRedisClient.mockReturnValue(redis);

    const out = await acquireLock("booking:123", 3000);

    expect(out).toEqual({
      acquired: true,
      token: null,
      skipped: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Redis lock acquire failed; continuing without distributed lock (non-production)",
      expect.objectContaining({
        key: "booking:123",
        message: "redis unavailable",
      })
    );
  });
});
