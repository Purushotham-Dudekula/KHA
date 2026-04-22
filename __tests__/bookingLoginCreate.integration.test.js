/**
 * Integration tests: OTP "login" -> booking create, plus concurrency + auth failure.
 */
jest.mock("../src/utils/otpCrypto", () => ({
  generateSixDigitOtp: jest.fn(() => "123456"),
}));

const request = require("supertest");

const { createApp } = require("../src/app");
const Commission = require("../src/models/commission.model");
const Service = require("../src/models/service.model");
const User = require("../src/models/user.model");
const Tractor = require("../src/models/tractor.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, futureBookingDate } = require("./helpers/mongoMemoryHarness");
const { invalidateServiceCache } = require("../src/services/serviceCache.service");

async function seedForBookingCreate() {
  invalidateServiceCache();

  await Commission.create({ percentage: 10, active: true });
  await Service.create({
    name: "Integration Test Service",
    code: "int_test_svc",
    pricePerAcre: 500,
    pricePerHour: 0,
    isActive: true,
    types: [],
  });

  const operator = await User.create({
    phone: "9999000003",
    role: "operator",
    verificationStatus: "approved",
    name: "Op Test",
    landArea: 0,
  });

  const farmer = await User.create({
    phone: "9999000004",
    role: "farmer",
    verificationStatus: "approved",
    name: "Farmer Test",
    landArea: 10,
  });

  const tractor = await Tractor.create({
    operatorId: operator._id,
    tractorType: "medium",
    brand: "BrandX",
    model: "ModelY",
    registrationNumber: `REG-INT-${Date.now()}`,
    machineryTypes: ["int_test_svc"],
    verificationStatus: "approved",
    isAvailable: true,
  });

  invalidateServiceCache();

  return { farmerPhone: farmer.phone, tractor };
}

function bookingCreateBody(tractorId) {
  return {
    tractorId: String(tractorId),
    serviceType: "int_test_svc",
    date: futureBookingDate(),
    time: "10:00",
    landArea: 5,
    address: "Farm lane 1",
  };
}

async function otpLogin(app, phone) {
  await request(app).post("/api/v1/auth/send-otp").send({ phone }).expect(200);
  const verify = await request(app).post("/api/v1/auth/verify-otp").send({ phone, otp: "123456" }).expect(200);
  return verify.body.data.token;
}

describe("Booking create integration", () => {
  let app;
  let tractorId;
  let farmerPhone;
  let bookingBody;

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
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_1";

    const seeded = await seedForBookingCreate();
    farmerPhone = seeded.farmerPhone;
    tractorId = seeded.tractor._id;
    bookingBody = bookingCreateBody(tractorId);
  });

  test("login then create booking succeeds (201, success=true)", async () => {
    const token = await otpLogin(app, farmerPhone);

    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${token}`)
      .send(bookingBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test("two parallel booking requests: one success (201) and one conflict (409)", async () => {
    const token = await otpLogin(app, farmerPhone);

    const [a, b] = await Promise.all([
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${token}`).send(bookingBody),
      request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${token}`).send(bookingBody),
    ]);

    const success = [a, b].find((r) => r.status === 201);
    const conflict = [a, b].find((r) => r.status === 409);

    expect(success).toBeTruthy();
    expect(success.body.success).toBe(true);
    expect(conflict).toBeTruthy();
    expect(conflict.status).toBe(409);
  });

  test("invalid token returns 401", async () => {
    const res = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", "Bearer invalid_token")
      .send(bookingBody);

    expect(res.status).toBe(401);
  });
});

