jest.mock("../../src/services/redis.service", () => ({
  getRedisClient: jest.fn(),
}));

const { getRedisClient } = require("../../src/services/redis.service");
const { acquireLock } = require("../../src/services/redisLock.service");

describe("redisLock.service extra unit tests", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("Lock success", async () => {
    process.env.NODE_ENV = "development";
    getRedisClient.mockReturnValue({
      set: jest.fn().mockResolvedValue("OK"),
    });

    const out = await acquireLock("lock:booking:1", 5000);
    expect(out).toMatchObject({
      acquired: true,
      skipped: false,
      token: expect.any(String),
    });
  });

  test("Lock fail", async () => {
    process.env.NODE_ENV = "development";
    getRedisClient.mockReturnValue({
      set: jest.fn().mockResolvedValue(null),
    });

    const out = await acquireLock("lock:booking:1", 5000);
    expect(out).toMatchObject({
      acquired: false,
      skipped: false,
      token: expect.any(String),
    });
  });

  test("Redis error fallback", async () => {
    process.env.NODE_ENV = "development";
    getRedisClient.mockReturnValue({
      set: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    });

    const out = await acquireLock("lock:booking:1", 5000);
    expect(out).toEqual({
      acquired: true,
      token: null,
      skipped: true,
    });
  });
});
