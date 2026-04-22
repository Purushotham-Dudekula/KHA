const request = require("supertest");

const { createApp } = require("../../src/app");
const Notification = require("../../src/models/notification.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, seedBookingFixtures } = require("../helpers/mongoMemoryHarness");

describe("notification.controller", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("list notifications -> success", async () => {
    const { farmerToken, farmer } = await seedBookingFixtures();

    await Notification.create([
      { userId: farmer._id, title: "N1", message: "M1", type: "alert", isRead: false },
      { userId: farmer._id, title: "N2", message: "M2", type: "booking", isRead: true },
    ]);

    const res = await request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.count).toBe(2);
    expect(Array.isArray(res.body.data.notifications)).toBe(true);
    expect(res.body.data.notifications.length).toBe(2);
  });

  test("unauthorized -> 401", async () => {
    const res = await request(app).get("/api/v1/notifications");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("pagination limits", async () => {
    const { farmerToken, farmer } = await seedBookingFixtures();

    const docs = Array.from({ length: 105 }, (_, i) => ({
      userId: farmer._id,
      title: `N${i}`,
      message: `M${i}`,
      type: i % 2 === 0 ? "alert" : "booking",
      isRead: false,
    }));
    await Notification.insertMany(docs);

    const res = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${farmerToken}`)
      .query({ limit: 200, page: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.notifications.length).toBe(50);
    expect(res.body.data.count).toBe(50);
  });

  test("mark read/unread", async () => {
    const { farmerToken, farmer } = await seedBookingFixtures();

    const n1 = await Notification.create({ userId: farmer._id, title: "N1", message: "M1", type: "alert", isRead: false });
    await Notification.create({ userId: farmer._id, title: "N2", message: "M2", type: "booking", isRead: true });

    const unreadRes = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${farmerToken}`)
      .query({ isRead: false });

    expect(unreadRes.status).toBe(200);
    expect(unreadRes.body.success).toBe(true);
    expect(unreadRes.body.data.count).toBe(1);
    expect(unreadRes.body.data.notifications[0]._id).toBe(String(n1._id));

    const readRes = await request(app)
      .patch(`/api/v1/notifications/${n1._id}/read`)
      .set("Authorization", `Bearer ${farmerToken}`);

    expect(readRes.status).toBe(200);
    expect(readRes.body.success).toBe(true);
    expect(readRes.body.data.notification.isRead).toBe(true);

    const unreadAfter = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${farmerToken}`)
      .query({ isRead: false });

    expect(unreadAfter.status).toBe(200);
    expect(unreadAfter.body.success).toBe(true);
    expect(unreadAfter.body.data.count).toBe(0);

    // Mark all read (should not error; modified could be 0 now).
    const allReadRes = await request(app).patch("/api/v1/notifications/read-all").set("Authorization", `Bearer ${farmerToken}`);
    expect(allReadRes.status).toBe(200);
    expect(allReadRes.body.success).toBe(true);
  });
});

