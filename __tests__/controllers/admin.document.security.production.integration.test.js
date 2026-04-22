const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");
const Admin = require("../../src/models/admin.model");
const User = require("../../src/models/user.model");
const Tractor = require("../../src/models/tractor.model");

describe("admin secure document access (production)", () => {
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
    process.env.NODE_ENV = "production";
    process.env.REQUIRE_SECURE_DOCUMENTS = "true";
    process.env.STORAGE_PROVIDER = "s3";
    process.env.AWS_ACCESS_KEY_ID = "test_key";
    process.env.AWS_SECRET_ACCESS_KEY = "test_secret";
    process.env.AWS_S3_BUCKET = "test-bucket";
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test("non-signed document URL in production returns 403", async () => {
    const admin = await Admin.create({
      name: "Admin Secure Doc",
      email: "admin.secure.doc@test.local",
      role: "admin",
      isActive: true,
    });
    const operator = await User.create({
      phone: "+919999901111",
      role: "operator",
      name: "Operator Secure Doc",
      verificationStatus: "approved",
    });
    const tractor = await Tractor.create({
      operatorId: operator._id,
      tractorType: "medium",
      brand: "BrandX",
      model: "ModelY",
      registrationNumber: `REG-SEC-${Date.now()}`,
      machineryTypes: ["int_test_svc"],
      verificationStatus: "approved",
      isAvailable: true,
      rcDocument: "https://test-bucket.s3.ap-south-1.amazonaws.com/uploads/plain-unsigned.pdf",
    });

    const adminToken = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    const res = await request(app)
      .get(`/api/v1/admin/tractor/${tractor._id}/document/rc`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });
});
