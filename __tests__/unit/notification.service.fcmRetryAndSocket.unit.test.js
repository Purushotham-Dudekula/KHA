jest.mock("../../src/models/notification.model", () => ({
  create: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
}));
jest.mock("../../src/services/fcm.service", () => ({
  sendPushNotification: jest.fn(),
}));
jest.mock("../../src/models/notificationRetry.model", () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/queues/notification.queue", () => ({
  enqueueNotificationRetryJob: jest.fn().mockResolvedValue(undefined),
  startNotificationWorker: jest.fn(() => null),
}));

const mongoose = require("mongoose");
const NotificationRetry = require("../../src/models/notificationRetry.model");
const { sendPushNotification } = require("../../src/services/fcm.service");
const { logger } = require("../../src/utils/logger");
const { notifyUser } = require("../../src/services/notification.service");

describe("notification.service — FCM failure (retry queue) and socket edge cases", () => {
  const uid = new mongoose.Types.ObjectId();

  beforeEach(() => {
    NotificationRetry.create.mockClear();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("FCM failure enqueues notification retry record", async () => {
    const Notification = require("../../src/models/notification.model");
    const User = require("../../src/models/user.model");
    Notification.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    User.findById.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ fcmToken: "bad-token" }),
      }),
    });
    sendPushNotification.mockRejectedValueOnce(new Error("fcm down"));

    await notifyUser({
      req: null,
      app: null,
      userId: uid,
      message: "m",
      type: "alert",
      title: "T",
    });

    expect(NotificationRetry.create).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test("socket emit failure is logged when io and doc exist", async () => {
    const Notification = require("../../src/models/notification.model");
    const User = require("../../src/models/user.model");
    Notification.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    User.findById.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ fcmToken: "" }),
      }),
    });
    const to = jest.fn().mockReturnValue({
      emit: jest.fn(() => {
        throw new Error("emit fail");
      }),
    });
    const io = { to };
    const app = { get: (name) => (name === "io" ? io : null) };

    await notifyUser({
      req: null,
      app,
      userId: uid,
      message: "x",
      type: "booking",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "Socket.IO notification emit failed (non-blocking)",
      expect.objectContaining({ message: "emit fail" })
    );
  });
});
