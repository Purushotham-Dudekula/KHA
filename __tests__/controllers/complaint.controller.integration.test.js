const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");

const { createApp } = require("../../src/app");
const Admin = require("../../src/models/admin.model");
const Complaint = require("../../src/models/complaint.model");
const User = require("../../src/models/user.model");

const { connectMongoMemory, disconnectMongoMemory, resetDatabase } = require("../helpers/mongoMemoryHarness");

describe("complaint.controller (admin respond)", () => {
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

  test("respond complaint success", async () => {
    const admin = await Admin.create({
      name: "Complaint Admin",
      email: "complaint_admin@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const user = await User.create({ phone: "9998000001", role: "farmer", name: "User Test" });
    const complaint = await Complaint.create({
      category: "Payment",
      message: "Test complaint message",
      userId: user._id,
      status: "open",
    });

    const res = await request(app)
      .patch(`/api/v1/admin/complaints/${complaint._id}/respond`)
      .set("Authorization", `Bearer ${token}`)
      .send({ adminResponse: "Resolved by admin", status: "resolved" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.complaint?.status).toBe("resolved");
  });

  test("missing adminResponse -> 400", async () => {
    const admin = await Admin.create({
      name: "Complaint Admin 2",
      email: "complaint_admin2@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const res = await request(app)
      .patch(`/api/v1/admin/complaints/${new mongoose.Types.ObjectId().toString()}/respond`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("invalid status -> 400", async () => {
    const admin = await Admin.create({
      name: "Complaint Admin 3",
      email: "complaint_admin3@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const user = await User.create({ phone: "9998000002", role: "farmer", name: "User Test 2" });
    const complaint = await Complaint.create({
      category: "Other",
      message: "Test complaint message 2",
      userId: user._id,
      status: "open",
    });

    const res = await request(app)
      .patch(`/api/v1/admin/complaints/${complaint._id}/respond`)
      .set("Authorization", `Bearer ${token}`)
      .send({ adminResponse: "Some response", status: "closed" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("complaint not found -> 404", async () => {
    const admin = await Admin.create({
      name: "Complaint Admin 4",
      email: "complaint_admin4@example.com",
      role: "admin",
      isActive: true,
    });
    const token = jwt.sign({ id: String(admin._id), scope: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const res = await request(app)
      .patch(`/api/v1/admin/complaints/${new mongoose.Types.ObjectId().toString()}/respond`)
      .set("Authorization", `Bearer ${token}`)
      .send({ adminResponse: "Resolved by admin", status: "in_progress" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

