describe("fcm.service", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  test("sendPushNotification returns false when token empty", async () => {
    const { sendPushNotification } = require("../../src/services/fcm.service");
    expect(await sendPushNotification({ token: "", title: "t" })).toBe(false);
  });

  test("initFirebaseIfConfigured returns false when ENABLE_FIREBASE_FCM is not true", () => {
    process.env.ENABLE_FIREBASE_FCM = "false";
    jest.isolateModules(() => {
      const { initFirebaseIfConfigured } = require("../../src/services/fcm.service");
      expect(initFirebaseIfConfigured()).toBe(false);
    });
  });
});
