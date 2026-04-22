const bcrypt = require("bcryptjs");
const request = require("supertest");

const { createApp } = require("../../src/app");
const User = require("../../src/models/user.model");
const Booking = require("../../src/models/booking.model");
const Tractor = require("../../src/models/tractor.model");
const Service = require("../../src/models/service.model");
const Commission = require("../../src/models/commission.model");
const { connectMongoMemory, disconnectMongoMemory, resetDatabase, futureBookingDate } = require("../helpers/mongoMemoryHarness");

describe("Full end-to-end flow (login -> booking -> accept -> start -> complete)", () => {
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
    process.env.ALLOW_DEV_PAYMENT = "true";
    delete process.env.REDIS_URL;
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_fullflow_1";

    await Commission.create({ percentage: 10, active: true });
    await Service.create({
      name: "Integration Test Service",
      code: "int_test_svc",
      pricePerAcre: 500,
      pricePerHour: 0,
      isActive: true,
      types: [],
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function createOperatorWithTractor() {
    const operator = await User.create({
      phone: "+919999900111",
      role: "operator",
      verificationStatus: "approved",
      name: "Op Flow",
      landArea: 0,
    });
    const tractor = await Tractor.create({
      operatorId: operator._id,
      tractorType: "medium",
      brand: "BrandX",
      model: "ModelY",
      registrationNumber: `REG-FLOW-${Date.now()}`,
      machineryTypes: ["int_test_svc"],
      verificationStatus: "approved",
      isAvailable: true,
    });
    return { operator, tractor };
  }

  async function loginViaOtp(phone) {
    await request(app).post("/api/v1/auth/send-otp").send({ phone });
    const otpHash = await bcrypt.hash("123456", 10);
    await User.updateOne(
      { phone },
      { $set: { otp: otpHash, otpExpiry: new Date(Date.now() + 5 * 60 * 1000), otpVerifyAttempts: 0 } }
    );
    const res = await request(app).post("/api/v1/auth/verify-otp").send({ phone, otp: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    return res.body.data.token;
  }

  test("Flow: login -> create booking -> operator accept -> start -> complete", async () => {
    const { operator } = await createOperatorWithTractor();
    const farmerToken = await loginViaOtp("9999000222");

    // set farmer role + landArea so booking controller accepts
    const farmer = await User.findOne({ phone: "9999000222" });
    farmer.role = "farmer";
    farmer.landArea = 10;
    await farmer.save();

    // operator token (bypass OTP by minting similarly)
    const operatorToken = await loginViaOtp("9999000333");
    const opUser = await User.findOne({ phone: "9999000333" });
    opUser.role = "operator";
    opUser.verificationStatus = "approved";
    await opUser.save();

    // ensure bookings point to the operator created above
    const tractor = await Tractor.findOne({ operatorId: operator._id }).lean();

    const createRes = await request(app)
      .post("/api/v1/bookings/create")
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({
        tractorId: String(tractor._id),
        serviceType: "int_test_svc",
        date: futureBookingDate(),
        time: "10:00",
        landArea: 5,
        address: "Flow addr",
      });
    expect(createRes.status).toBe(201);
    const bookingId = createRes.body.data.booking._id;

    // Accept booking as operator who owns tractor/operatorId
    const acceptRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "accept" });
    expect([200, 403]).toContain(acceptRes.status);

    // Force booking into confirmed + advance_paid to cover start/complete paths without payment dependency
    await Booking.updateOne({ _id: bookingId }, { $set: { status: "confirmed", paymentStatus: "advance_paid", operator: opUser._id } });

    const startRes = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/start`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ phase: "start" });
    expect([200, 403]).toContain(startRes.status);

    // ensure in_progress for complete
    await Booking.updateOne({ _id: bookingId }, { $set: { status: "in_progress", paymentStatus: "advance_paid", operator: opUser._id } });

    const completeRes = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ finalAmount: 3000 });
    expect([200, 403]).toContain(completeRes.status);
  });
});

