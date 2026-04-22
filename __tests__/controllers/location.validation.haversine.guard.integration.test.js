const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../../src/models/user.model");
const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

const mockFindNearbyOperators = jest.fn();
jest.mock("../../src/services/user.service", () => ({
  ...jest.requireActual("../../src/services/user.service"),
  findNearbyOperators: (...args) => mockFindNearbyOperators(...args),
}));

describe("lat/lon validation guard (BUG-007)", () => {
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

  async function farmerAuth() {
    const u = await User.create({ phone: `+9193333${Date.now()}`, role: "farmer", name: "Loc Farmer", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return { token };
  }

  test("lat 91 -> 400", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: 91, longitude: 78 });
    expect(res.status).toBe(400);
  });

  test("lat -91 -> 400", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: -91, longitude: 78 });
    expect(res.status).toBe(400);
  });

  test("lon 181 -> 400", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: 17, longitude: 181 });
    expect(res.status).toBe(400);
  });

  test("lon -181 -> 400", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: 17, longitude: -181 });
    expect(res.status).toBe(400);
  });

  test("lat 0, lon 0 -> passes validation", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: 0, longitude: 0 });
    expect(res.status).toBe(200);
  });

  test('lat "abc" -> 400', async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ latitude: "abc", longitude: 77 });
    expect(res.status).toBe(400);
  });

  test("lat missing -> 400", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .patch("/api/v1/user/location")
      .set("Authorization", `Bearer ${token}`)
      .send({ longitude: 77 });
    expect(res.status).toBe(400);
  });

  test("nearby search returns empty arrays (no crash) when no operators in range", async () => {
    const { token } = await farmerAuth();
    const res = await request(app)
      .get("/api/v1/user/nearby-operators?lat=17&lng=78&radius=5000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.onlineOperators)).toBe(true);
    expect(Array.isArray(res.body.data.offlineOperators)).toBe(true);
    expect(res.body.data.onlineOperators).toHaveLength(0);
    expect(res.body.data.offlineOperators).toHaveLength(0);
  });
});
