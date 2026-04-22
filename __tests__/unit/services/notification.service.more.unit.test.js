jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose");
  return { ...actual, Types: { ...actual.Types, ObjectId: function ObjectId(v) { return v || "oid"; } } };
});
jest.mock("../../../src/models/notification.model", () => ({
  create: jest.fn(),
}));
jest.mock("../../../src/models/notificationRetry.model", () => ({
  create: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  deleteMany: jest.fn(),
}));
jest.mock("../../../src/models/user.model", () => ({
  findById: jest.fn(),
}));
jest.mock("../../../src/services/fcm.service", () => ({
  sendPushNotification: jest.fn(),
}));
jest.mock("../../../src/queues/notification.queue", () => ({
  enqueueNotificationRetryJob: jest.fn(),
  startNotificationWorker: jest.fn(() => null),
}));
jest.mock("../../../src/utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const Notification = require("../../../src/models/notification.model");
const NotificationRetry = require("../../../src/models/notificationRetry.model");
const User = require("../../../src/models/user.model");
const { sendPushNotification } = require("../../../src/services/fcm.service");

describe("notification.service (more unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("notifyUser persists and emits socket event", async () => {
    const { notifyUser } = require("../../../src/services/notification.service");
    Notification.create.mockResolvedValueOnce({ _id: "n1" });
    User.findById.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ fcmToken: "" }) }) });
    const emit = jest.fn();
    const io = { to: () => ({ emit }) };
    const req = { app: { get: () => io } };
    const out = await notifyUser({ req, userId: "u1", message: "m", type: "booking", title: "t" });
    expect(out).toBeTruthy();
    expect(emit).toHaveBeenCalled();
  });

  test("notifyUser handles Notification.create failure (non-blocking)", async () => {
    const { notifyUser } = require("../../../src/services/notification.service");
    Notification.create.mockRejectedValueOnce(new Error("db fail"));
    User.findById.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ fcmToken: "" }) }) });
    await expect(notifyUser({ req: {}, userId: "u1", message: "m" })).resolves.toBeNull();
  });

  test("notifyUser queues retry on push failure", async () => {
    const { notifyUser } = require("../../../src/services/notification.service");
    Notification.create.mockResolvedValueOnce({ _id: "n1" });
    User.findById.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ fcmToken: "tok" }) }) });
    sendPushNotification.mockRejectedValueOnce(new Error("fcm down"));
    NotificationRetry.create.mockResolvedValueOnce({});
    await notifyUser({ req: {}, userId: "u1", message: "m", bookingId: "b1" });
    expect(NotificationRetry.create).toHaveBeenCalled();
  });

  test("notifyUsers iterates list", async () => {
    const { notifyUsers } = require("../../../src/services/notification.service");
    Notification.create.mockResolvedValue({ _id: "n1" });
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ fcmToken: "" }) }) });
    await notifyUsers(null, {}, [{ userId: "u1", message: "a" }, { userId: "u2", message: "b" }]);
    expect(Notification.create).toHaveBeenCalledTimes(2);
  });

  test("notifyAdvanceReceived delegates", async () => {
    const { notifyAdvanceReceived } = require("../../../src/services/notification.service");
    Notification.create.mockResolvedValue({ _id: "n1" });
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ fcmToken: "" }) }) });
    await notifyAdvanceReceived({}, "u1", "b1");
    expect(Notification.create).toHaveBeenCalled();
  });
});

