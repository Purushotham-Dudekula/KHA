const request = require("supertest");
const mongoose = require("mongoose");

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  createPendingBookingForFarmer,
  futureBookingDate,
} = require("../helpers/mongoMemoryHarness");

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

describe("booking.controller edge cases", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    await resetDatabase();
  });

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
  });

  test("payment lock conflict -> 409", async () => {
    const { farmerToken } = await seedBookingFixtures();
    process.env.NODE_ENV = "production";
    process.env.REDIS_URL = "";

    const bookingId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(`/api/v1/bookings/${bookingId}/pay-advance`)
      .set("Authorization", `Bearer ${farmerToken}`)
      .send({ paymentMethod: "upi", paymentId: "pay_lock_conflict_1" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("invalid tractorId -> 400", async () => {
    const { farmerToken } = await seedBookingFixtures();
    const body = bookingCreateBody("not-an-objectid");

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("invalid serviceType -> 400", async () => {
    const { farmerToken, tractor } = await seedBookingFixtures();

    const body = bookingCreateBody(tractor._id);
    body.serviceType = "invalid_service_type";

    const res = await request(app).post("/api/v1/bookings/create").set("Authorization", `Bearer ${farmerToken}`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("operator accept/reject flow", async () => {
    const { farmerToken: _farmerToken, operatorToken, farmer, operator, tractor } =
      await seedBookingFixtures();

    const bookingAccept = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const acceptRes = await request(app)
      .post(`/api/v1/bookings/${bookingAccept._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "accept" });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.success).toBe(true);
    expect(acceptRes.body.data.booking.status).toBe("accepted");

    // Second booking for reject flow.
    const bookingReject = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const rejectRes = await request(app)
      .post(`/api/v1/bookings/${bookingReject._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "reject" });

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.success).toBe(true);
    expect(rejectRes.body.data.booking.status).toBe("rejected");
  });
});

