describe("fcm.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("initFirebaseIfConfigured -> false when disabled", () => {
    process.env.ENABLE_FIREBASE_FCM = "false";
    const { initFirebaseIfConfigured } = require("../../../src/services/fcm.service");
    expect(initFirebaseIfConfigured()).toBe(false);
  });

  test("initFirebaseIfConfigured -> false when firebase-admin missing", () => {
    process.env.ENABLE_FIREBASE_FCM = "true";
    jest.doMock("fs", () => ({ existsSync: jest.fn(() => false) }));
    const { initFirebaseIfConfigured } = require("../../../src/services/fcm.service");
    expect(initFirebaseIfConfigured()).toBe(false);
  });

  test("sendPushNotification -> false on empty token", async () => {
    const { sendPushNotification } = require("../../../src/services/fcm.service");
    await expect(sendPushNotification({ token: "", title: "t", body: "b" })).resolves.toBe(false);
  });

  test("sendPushNotification -> true when configured + messaging send ok", async () => {
    process.env.ENABLE_FIREBASE_FCM = "true";

    // Force "serviceAccountKey.json exists"
    jest.doMock("fs", () => ({ existsSync: jest.fn(() => true) }));

    const adminMock = {
      apps: [],
      credential: { cert: jest.fn(() => ({}) ) },
      initializeApp: jest.fn(() => {}),
      messaging: () => ({ send: jest.fn().mockResolvedValueOnce("ok") }),
    };
    jest.doMock("firebase-admin", () => adminMock, { virtual: true });

    // Mock requiring the resolved service account path
    const path = require("path");
    const svcPath = path.join(process.cwd(), "serviceAccountKey.json");
    jest.doMock(svcPath, () => ({}), { virtual: true });

    const { sendPushNotification } = require("../../../src/services/fcm.service");
    const ok = await sendPushNotification({ token: "tok", title: "t", body: "b", data: { a: 1, b: null } });
    expect(ok).toBe(true);
  });
});

