jest.mock("../../src/models/notification.model", () => ({
  create: jest.fn(),
}));
jest.mock("../../src/models/user.model", () => ({
  findById: jest.fn(),
}));
jest.mock("../../src/services/fcm.service", () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../src/models/notificationRetry.model", () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/queues/notification.queue", () => ({
  enqueueNotificationRetryJob: jest.fn().mockResolvedValue(undefined),
  startNotificationWorker: jest.fn(() => null),
}));

const mongoose = require("mongoose");
const Notification = require("../../src/models/notification.model");
const User = require("../../src/models/user.model");
const { sendPushNotification } = require("../../src/services/fcm.service");
const { logger } = require("../../src/utils/logger");
const { notifyUser, notifyUsers, notifyAdvanceReceived } = require("../../src/services/notification.service");

describe("notification.service (notifyUser / notifyUsers)", () => {
  const uid = new mongoose.Types.ObjectId();

  beforeEach(() => {
    Notification.create.mockReset();
    User.findById.mockReset();
    sendPushNotification.mockClear();
    Notification.create.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      _doc: {},
    });
    User.findById.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ fcmToken: "" }),
      }),
    });
  });

  test("notifyUser persists and skips FCM when no token", async () => {
    const doc = await notifyUser({
      req: null,
      app: null,
      userId: uid,
      message: "hello",
      type: "alert",
      title: "T",
      bookingId: null,
    });
    expect(Notification.create).toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(doc).toBeTruthy();
  });

  test("notifyUser sends FCM when token present", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ fcmToken: "tok" }),
      }),
    });
    await notifyUser({
      req: null,
      app: null,
      userId: uid,
      message: "m",
      type: "payment",
      title: "",
      bookingId: null,
    });
    expect(sendPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok", title: "Payment update" })
    );
  });

  test("notifyUser maps advance_paid to payment category", async () => {
    await notifyUser({
      req: null,
      app: null,
      userId: uid,
      message: "x",
      type: "advance_paid",
      title: "",
    });
    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment" })
    );
  });

  test("notifyUser logs when Notification.create fails", async () => {
    Notification.create.mockRejectedValueOnce(new Error("db"));
    jest.spyOn(logger, "error").mockImplementation(() => {});
    await notifyUser({
      req: null,
      app: null,
      userId: uid,
      message: "m",
      type: "booking",
    });
    expect(logger.error).toHaveBeenCalled();
  });

  test("notifyUsers iterates items", async () => {
    await notifyUsers(null, null, [
      { userId: uid, message: "a", type: "alert", title: "x" },
      { userId: uid, message: "b", type: "alert", title: "y" },
    ]);
    expect(Notification.create).toHaveBeenCalledTimes(2);
  });

  test("notifyAdvanceReceived delegates to notifyUser", async () => {
    await notifyAdvanceReceived(null, uid, null);
    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment", title: "Advance received" })
    );
  });

  test("invalid userId string throws (invalid input)", async () => {
    await expect(
      notifyUser({
        req: null,
        app: null,
        userId: "not-a-valid-object-id",
        message: "m",
        type: "alert",
      })
    ).rejects.toThrow();
  });
});
