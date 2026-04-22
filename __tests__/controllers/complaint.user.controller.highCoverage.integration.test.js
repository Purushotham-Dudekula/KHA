/**
 * complaint.controller — user-facing POST/GET /complaints.
 */
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");

const User = require("../../src/models/user.model");
const Booking = require("../../src/models/booking.model");
const Complaint = require("../../src/models/complaint.model");
const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

describe("complaint.controller user API (high coverage)", () => {
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
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("POST /complaints without token → 401", async () => {
    const res = await request(app).post("/api/v1/complaints").send({ message: "Hi", category: "General" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ success: false, message: expect.any(String) }));
  });

  test("POST /complaints missing message → 400", async () => {
    const u = await User.create({ phone: "+919222200001", role: "farmer", name: "C", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "General" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints invalid category → 400", async () => {
    const u = await User.create({ phone: "+919222200002", role: "farmer", name: "C2", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Bad cat", category: "Unknown" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints General without bookingId → 201", async () => {
    const u = await User.create({ phone: "+919222200003", role: "farmer", name: "C3", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "General issue", category: "general" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.complaint.category).toBe("General");
  });

  test("POST /complaints Payment without bookingId → 400", async () => {
    const u = await User.create({ phone: "+919222200004", role: "farmer", name: "C4", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Pay issue", category: "Payment" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints invalid bookingId → 400", async () => {
    const u = await User.create({ phone: "+919222200005", role: "farmer", name: "C5", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "X", category: "Payment", bookingId: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints booking not found → 404", async () => {
    const u = await User.create({ phone: "+919222200006", role: "farmer", name: "C6", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: "X",
        category: "Payment",
        bookingId: new mongoose.Types.ObjectId().toString(),
      });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints booking not owned → 403", async () => {
    const { farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 86400000),
      time: "10:00",
      address: "A",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 33,
      advanceAmount: 33,
      remainingAmount: 77,
    });
    const other = await User.create({ phone: "+919222200007", role: "farmer", name: "Other", landArea: 1 });
    const token = jwt.sign({ id: String(other._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: "Not mine",
        category: "Payment",
        bookingId: String(booking._id),
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("POST /complaints operator self Operator Issue on own booking → 400", async () => {
    const { farmer, operator, tractor, operatorToken } = await seedBookingFixtures();
    const booking = await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 86400000),
      time: "10:00",
      address: "A",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 33,
      advanceAmount: 33,
      remainingAmount: 77,
    });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        message: "Self complaint",
        category: "Operator Issue",
        bookingId: String(booking._id),
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Operators cannot file a complaint against their own booking");
  });

  test("POST /complaints operator on own booking → 400", async () => {
    const { farmer, operator, tractor, operatorToken } = await seedBookingFixtures();
    const booking = await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 86400000),
      time: "10:00",
      address: "A",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 33,
      advanceAmount: 33,
      remainingAmount: 77,
    });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        message: "Payment issue as operator",
        category: "Payment",
        bookingId: String(booking._id),
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Operators cannot file a complaint against their own booking");
  });

  test("POST /complaints with booking → 201", async () => {
    const { farmer, farmerToken, operator, tractor } = await seedBookingFixtures();
    const booking = await Booking.create({
      farmer: farmer._id,
      operator: operator._id,
      tractor: tractor._id,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: 5,
      serviceType: "int_test_svc",
      date: new Date(Date.now() + 86400000),
      time: "10:00",
      address: "A",
      baseAmount: 100,
      gstAmount: 0,
      platformFee: 10,
      totalAmount: 110,
      estimatedAmount: 110,
      finalAmount: 110,
      advancePayment: 33,
      advanceAmount: 33,
      remainingAmount: 77,
    });
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        message: "Payment problem",
        category: "Payment",
        bookingId: String(booking._id),
        images: ["  https://example.com/a.png  "],
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.complaint.bookingId).toBeTruthy();
  });

  test("GET /complaints → 200", async () => {
    const u = await User.create({ phone: "+919222200008", role: "farmer", name: "L", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    await Complaint.create({
      userId: u._id,
      message: "m",
      category: "General",
      status: "open",
    });
    const res = await request(app).get("/api/v1/complaints").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("complaints");
  });

  test("POST /complaints create failure → 500", async () => {
    const u = await User.create({ phone: "+919222200009", role: "farmer", name: "E", landArea: 1 });
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    jest.spyOn(Complaint, "create").mockRejectedValueOnce(new Error("db"));
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Err", category: "General" });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
