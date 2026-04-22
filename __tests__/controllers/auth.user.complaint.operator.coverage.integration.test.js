/**
 * Integration coverage: auth (refresh/logout/verify 404), user (me, nearby), complaint, operator.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("../../src/services/user.service", () => ({
  findNearbyOperators: jest.fn(async () => ({
    onlineOperators: [],
    offlineOperators: [],
  })),
}));

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

describe("auth + user + complaint + operator coverage (integration)", () => {
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
    jest.clearAllMocks();
  });

  describe("auth.controller", () => {
    test("POST /api/v1/auth/refresh without cookie -> 401", async () => {
      const res = await request(app).post("/api/v1/auth/refresh").send({ userId: "507f1f77bcf86cd7994390111" });
      expect(res.status).toBe(401);
    });

    test("POST /api/v1/auth/refresh invalid token format -> 401", async () => {
      const res = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", ["refreshToken=fake"])
        .send({ userId: "not-an-id" });
      expect(res.status).toBe(401);
    });

    test("POST /api/v1/auth/verify-otp user not found (no prior record) -> 404", async () => {
      const res = await request(app).post("/api/v1/auth/verify-otp").send({
        phone: "8888888888",
        otp: "123456",
      });
      expect(res.status).toBe(404);
    });

    test("POST /api/v1/auth/logout without token -> 401", async () => {
      const res = await request(app).post("/api/v1/auth/logout").send({});
      expect(res.status).toBe(401);
    });
  });

  describe("user.controller", () => {
    test("GET /api/v1/user/me without token -> 401", async () => {
      const res = await request(app).get("/api/v1/user/me");
      expect(res.status).toBe(401);
    });

    test("GET /api/v1/user/me with token -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/v1/user/me").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("GET /api/v1/user/nearby-operators missing lat -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .get("/api/v1/user/nearby-operators?lng=78&radius=10")
        .set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(400);
    });

    test("GET /api/v1/user/nearby-operators success -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .get("/api/v1/user/nearby-operators?lat=17.4&lng=78.5&radius=5")
        .set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("complaint.controller", () => {
    test("POST /api/v1/complaints missing message -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/v1/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ category: "General" });
      expect(res.status).toBe(400);
    });

    test("POST /api/v1/complaints invalid category -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/v1/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ message: "test", category: "NotARealCategory" });
      expect(res.status).toBe(400);
    });

    test("POST /api/v1/complaints General without bookingId -> 201", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/v1/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ message: "hello support", category: "General" });
      expect(res.status).toBe(201);
      expect(res.body.data.complaint).toBeDefined();
    });

    test("GET /api/v1/complaints list -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/v1/complaints").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.complaints)).toBe(true);
    });

    test("POST /api/v1/complaints bookingId not found -> 404", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/v1/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({
          message: "issue",
          category: "Payment",
          bookingId: "507f1f77bcf86cd799439011",
        });
      expect(res.status).toBe(404);
    });
  });

  describe("operator.controller", () => {
    test("GET /api/v1/operator/earnings as farmer -> 403", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/v1/operator/earnings").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(403);
    });

    test("GET /api/v1/operator/earnings as operator -> 200", async () => {
      const { operatorToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/v1/operator/earnings").set("Authorization", `Bearer ${operatorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("PATCH /api/v1/operator/bank-details invalid IFSC length -> 400 (validation)", async () => {
      const { operatorToken } = await seedBookingFixtures();
      const res = await request(app)
        .patch("/api/v1/operator/bank-details")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          accountHolderName: "Test",
          accountNumber: "1234567890",
          ifsc: "BAD",
          upiId: "",
        });
      expect(res.status).toBe(400);
    });
  });
});
