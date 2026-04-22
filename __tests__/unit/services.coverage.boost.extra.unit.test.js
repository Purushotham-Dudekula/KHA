describe("cache.service coverage boost", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("getCachedJson returns null when redis unavailable", async () => {
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => null),
    }));
    const svc = require("../../src/services/cache.service");
    await expect(svc.getCachedJson("k")).resolves.toBeNull();
  });

  test("getCachedJson handles invalid JSON and redis get throw", async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce("{bad")
      .mockRejectedValueOnce(new Error("redis down"));
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => ({ get })),
    }));
    const svc = require("../../src/services/cache.service");
    await expect(svc.getCachedJson("k1")).resolves.toBeNull();
    await expect(svc.getCachedJson("k2")).resolves.toBeNull();
  });

  test("setCachedJson returns false on missing client and set error", async () => {
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => null),
    }));
    let svc = require("../../src/services/cache.service");
    await expect(svc.setCachedJson("k", { a: 1 }, 10)).resolves.toBe(false);

    jest.resetModules();
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => ({ set: jest.fn().mockRejectedValue(new Error("x")) })),
    }));
    svc = require("../../src/services/cache.service");
    await expect(svc.setCachedJson("k", { a: 1 }, 10)).resolves.toBe(false);
  });

  test("setCachedJson clamps ttl and returns true on success", async () => {
    const set = jest.fn().mockResolvedValue("OK");
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => ({ set })),
    }));
    const svc = require("../../src/services/cache.service");
    await expect(svc.setCachedJson("k", { a: 1 }, 999999)).resolves.toBe(true);
    expect(set).toHaveBeenCalled();
  });

  test("getOrSetCachedJson returns cache hit and runs loader on miss", async () => {
    const get = jest.fn().mockResolvedValueOnce(JSON.stringify({ hit: true })).mockResolvedValueOnce(null);
    const set = jest.fn().mockResolvedValue("OK");
    const loader = jest.fn().mockResolvedValue({ fresh: true });
    jest.doMock("../../src/services/redis.service", () => ({
      getRedisClient: jest.fn(() => ({ get, set })),
    }));
    const svc = require("../../src/services/cache.service");
    await expect(svc.getOrSetCachedJson("k1", 10, loader)).resolves.toEqual({ hit: true });
    await expect(svc.getOrSetCachedJson("k2", 10, loader)).resolves.toEqual({ fresh: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("serviceImage.service coverage boost", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete global.fetch;
  });

  test("returns empty string for null/empty input", async () => {
    jest.doMock("../../src/services/storage.service", () => ({ uploadFile: jest.fn() }));
    const svc = require("../../src/services/serviceImage.service");
    await expect(svc.resolveServiceImageInput(null)).resolves.toBe("");
    await expect(svc.resolveServiceImageInput("   ")).resolves.toBe("");
  });

  test("passes through url and handles failed HEAD reachability", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404 });
    jest.doMock("../../src/services/storage.service", () => ({ uploadFile: jest.fn() }));
    const svc = require("../../src/services/serviceImage.service");
    await expect(svc.resolveServiceImageInput("https://example.com/a.jpg")).resolves.toBe(
      "https://example.com/a.jpg"
    );
  });

  test("throws on invalid input object", async () => {
    jest.doMock("../../src/services/storage.service", () => ({ uploadFile: jest.fn() }));
    const svc = require("../../src/services/serviceImage.service");
    await expect(svc.resolveServiceImageInput({ nope: true })).rejects.toThrow(
      "Invalid image format or size"
    );
  });

  test("throws when data uri mime is unsupported", async () => {
    jest.doMock("../../src/services/storage.service", () => ({ uploadFile: jest.fn() }));
    const svc = require("../../src/services/serviceImage.service");
    const badData = `data:image/gif;base64,${Buffer.from("abc").toString("base64")}`;
    await expect(svc.resolveServiceImageInput(badData)).rejects.toThrow("Invalid image format or size");
  });
});

describe("notification.service coverage boost", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.JEST_WORKER_ID;
  });

  test("returns null when notifications disabled", async () => {
    jest.doMock("../../src/config/env", () => ({ env: { enableNotifications: false } }));
    jest.doMock("../../src/models/notification.model", () => ({ create: jest.fn() }));
    jest.doMock("../../src/models/notificationRetry.model", () => ({
      create: jest.fn(),
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([]) }) }) })),
      updateOne: jest.fn(),
      deleteMany: jest.fn(),
    }));
    jest.doMock("../../src/models/user.model", () => ({ findById: jest.fn() }));
    jest.doMock("../../src/services/fcm.service", () => ({ sendPushNotification: jest.fn() }));
    jest.doMock("../../src/queues/notification.queue", () => ({
      enqueueNotificationRetryJob: jest.fn(),
      startNotificationWorker: jest.fn(() => null),
    }));
    const svc = require("../../src/services/notification.service");
    await expect(
      svc.notifyUser({ userId: "507f191e810c19729de860ea", message: "m", type: "booking" })
    ).resolves.toBeNull();
  });

  test("notifyUser continues when Notification.create fails", async () => {
    const create = jest.fn().mockRejectedValue(new Error("db"));
    const findById = jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue({ fcmToken: "" }) }) }));
    jest.doMock("../../src/config/env", () => ({ env: { enableNotifications: true } }));
    jest.doMock("../../src/models/notification.model", () => ({ create }));
    jest.doMock("../../src/models/notificationRetry.model", () => ({
      create: jest.fn(),
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([]) }) }) })),
      updateOne: jest.fn(),
      deleteMany: jest.fn(),
    }));
    jest.doMock("../../src/models/user.model", () => ({ findById }));
    jest.doMock("../../src/services/fcm.service", () => ({ sendPushNotification: jest.fn() }));
    jest.doMock("../../src/queues/notification.queue", () => ({
      enqueueNotificationRetryJob: jest.fn(),
      startNotificationWorker: jest.fn(() => null),
    }));
    const svc = require("../../src/services/notification.service");
    const req = { app: { get: jest.fn(() => null) } };
    await expect(
      svc.notifyUser({ req, userId: "507f191e810c19729de860ea", message: "hello", type: "unknown" })
    ).resolves.toBeNull();
  });

  test("notifyUser queues retry when push throws", async () => {
    const retryCreate = jest.fn().mockResolvedValue({});
    const sendPushNotification = jest.fn().mockRejectedValue(new Error("fcm fail"));
    const enqueueNotificationRetryJob = jest.fn().mockResolvedValue(true);
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    jest.doMock("../../src/config/env", () => ({ env: { enableNotifications: true } }));
    jest.doMock("../../src/models/notification.model", () => ({
      create: jest.fn().mockResolvedValue({ _id: "n1" }),
    }));
    jest.doMock("../../src/models/notificationRetry.model", () => ({
      create: retryCreate,
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([]) }) }) })),
      updateOne: jest.fn(),
      deleteMany: jest.fn(),
    }));
    jest.doMock("../../src/models/user.model", () => ({
      findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue({ fcmToken: "tok" }) }) })),
    }));
    jest.doMock("../../src/services/fcm.service", () => ({ sendPushNotification }));
    jest.doMock("../../src/queues/notification.queue", () => ({
      enqueueNotificationRetryJob,
      startNotificationWorker: jest.fn(() => null),
    }));
    const svc = require("../../src/services/notification.service");
    const req = { app: { get: jest.fn(() => io) } };
    await expect(
      svc.notifyUser({
        req,
        userId: "507f191e810c19729de860ea",
        message: "m",
        type: "payment_pending",
        bookingId: "507f191e810c19729de860eb",
      })
    ).resolves.toBeTruthy();
    expect(sendPushNotification).toHaveBeenCalled();
    expect(retryCreate).toHaveBeenCalled();
  });
});
