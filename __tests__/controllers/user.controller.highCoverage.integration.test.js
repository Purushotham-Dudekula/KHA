/**
 * user.controller — HTTP branches (success, 4xx, mocked 5xx).
 */
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../../src/models/user.model");
const Notification = require("../../src/models/notification.model");
const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

const mockFindNearbyOperators = jest.fn();
jest.mock("../../src/services/user.service", () => ({
  ...jest.requireActual("../../src/services/user.service"),
  findNearbyOperators: (...args) => mockFindNearbyOperators(...args),
}));

describe("user.controller (high coverage)", () => {
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
    process.env.REDIS_DISABLED = "true";
    delete process.env.REDIS_URL;
    mockFindNearbyOperators.mockReset();
    mockFindNearbyOperators.mockResolvedValue({ onlineOperators: [], offlineOperators: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function expectApiShape(res, success) {
    expect(res.body).toEqual(
      expect.objectContaining({
        success,
        message: expect.any(String),
      })
    );
    if (success) expect(res.body).toHaveProperty("data");
  }

  test("GET /me → 200 with data.user shape", async () => {
    const u = await User.create({
      phone: "+919111100001",
      role: "farmer",
      name: "Me User",
      landArea: 5,
    });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/api/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("_id");
  });

  test("GET /me without token → 401", async () => {
    const res = await request(app).get("/api/v1/user/me");
    expect(res.status).toBe(401);
    expectApiShape(res, false);
  });

  test("GET /me when user missing from DB → 401 (auth middleware)", async () => {
    const ghostId = "507f1f77bcf86cd799439011";
    const token = jwt.sign({ id: ghostId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/api/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expectApiShape(res, false);
  });

  test("GET /dashboard DB failure does not break response", async () => {
    const { farmerToken } = await seedBookingFixtures();
    jest.spyOn(Notification, "countDocuments").mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/api/v1/user/dashboard").set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("activeBookings");
    expect(res.body.data).toHaveProperty("pendingPayments");
    expect(res.body.data).toHaveProperty("recentBookings");
    expect(res.body.data.notificationsCount).toBe(0);
  });

  test("POST /select-role missing body → 400 (Joi)", async () => {
    const u = await User.create({ phone: "+919111100003", role: "farmer", name: "R", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).post("/api/v1/user/select-role").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("POST /profile/farmer as operator → 403", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/user/profile/farmer")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        name: "F",
        village: "v",
        mandal: "m",
        district: "d",
        state: "s",
        pincode: "500001",
        landArea: 10,
      });
    expect(res.status).toBe(403);
    expectApiShape(res, false);
  });

  test("POST /profile/farmer valid → 200", async () => {
    const u = await User.create({ phone: "+919111100004", role: "farmer", name: "Old", landArea: 2 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/user/profile/farmer")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Farmer Full",
        village: "V1",
        mandal: "M1",
        district: "D1",
        state: "TS",
        pincode: "500002",
        landArea: 12,
        primaryCrop: "rice",
      });
    expect(res.status).toBe(200);
    expectApiShape(res, true);
    expect(res.body.data.user.name).toBe("Farmer Full");
  });

  test("POST /profile/farmer with operator-only field → 400", async () => {
    const u = await User.create({ phone: "+919111100005", role: "farmer", name: "F", landArea: 2 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/user/profile/farmer")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "F",
        village: "v",
        mandal: "m",
        district: "d",
        state: "s",
        pincode: "500003",
        landArea: 5,
        tractorType: "medium",
      });
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("POST /profile/operator as farmer → 403", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app)
      .post("/api/v1/user/profile/operator")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        name: "Op",
        village: "v",
        mandal: "m",
        district: "d",
        state: "s",
        pincode: "500004",
        experience: "1_3",
        education: "10th",
        aadhaarNumber: "123456789012",
      });
    expect(res.status).toBe(403);
    expectApiShape(res, false);
  });

  test("PATCH /location invalid coords → 400", async () => {
    const u = await User.create({ phone: "+919111100006", role: "farmer", name: "L", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: "x", longitude: 77 });
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("PATCH /status non-boolean → 400", async () => {
    const u = await User.create({ phone: "+919111100007", role: "operator", name: "O", landArea: 0 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .patch("/api/v1/user/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: "yes" });
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("PATCH /language invalid → 400", async () => {
    const u = await User.create({ phone: "+919111100008", role: "farmer", name: "Lang", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .patch("/api/v1/user/language")
      .set("Authorization", `Bearer ${token}`)
      .send({ language: "fr" });
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("POST /fcm-token empty → 400", async () => {
    const u = await User.create({ phone: "+919111100009", role: "farmer", name: "FCM", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/user/fcm-token")
      .set("Authorization", `Bearer ${token}`)
      .send({ fcmToken: "" });
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("GET /nearby-operators missing params → 400", async () => {
    const u = await User.create({ phone: "+919111100010", role: "farmer", name: "N", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/api/v1/user/nearby-operators").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("GET /nearby-operators → 200 empty lists", async () => {
    const u = await User.create({ phone: "+919111100011", role: "farmer", name: "N2", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .get("/api/v1/user/nearby-operators?lat=17&lng=78&radius=5000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expectApiShape(res, true);
    expect(Array.isArray(res.body.data.onlineOperators)).toBe(true);
    expect(Array.isArray(res.body.data.offlineOperators)).toBe(true);
  });

  test("GET /operators/:operatorId invalid id → 400", async () => {
    const u = await User.create({ phone: "+919111100012", role: "farmer", name: "P", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/api/v1/user/operators/bad-id").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expectApiShape(res, false);
  });

  test("GET /operators/:operatorId non-operator user → 404", async () => {
    const farmer = await User.create({ phone: "+919111100013", role: "farmer", name: "NF", landArea: 1 });
    const token = jwt.sign({ id: String(farmer._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .get(`/api/v1/user/operators/${String(farmer._id)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expectApiShape(res, false);
  });

  test("GET /dashboard as operator → 403", async () => {
    const { operatorToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/user/dashboard").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
    expectApiShape(res, false);
  });

  test("GET /dashboard as farmer → 200", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const res = await request(app).get("/api/v1/user/dashboard").set("Authorization", `Bearer ${farmerToken}`);
    expect(res.status).toBe(200);
    expectApiShape(res, true);
    expect(res.body.data).toHaveProperty("activeBookings");
  });
});
