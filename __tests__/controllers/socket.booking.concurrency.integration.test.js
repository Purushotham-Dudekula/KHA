const http = require("http");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const User = require("../../src/models/user.model");
const Booking = require("../../src/models/booking.model");
const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
  createPendingBookingForFarmer,
} = require("../helpers/mongoMemoryHarness");

describe("socket.io booking concurrency integration", () => {
  let app;
  let httpServer;
  let io;
  let baseUrl;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
    httpServer = http.createServer(app);
    io = new Server(httpServer, { cors: { origin: "*" } });

    io.use(async (socket, next) => {
      try {
        const auth = socket.handshake.auth || {};
        const token = typeof auth.token === "string" ? auth.token : null;
        if (!token) return next(new Error("Authentication required"));
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.id || !mongoose.Types.ObjectId.isValid(String(decoded.id))) {
          return next(new Error("Invalid token"));
        }
        const user = await User.findById(String(decoded.id)).select("isBlocked").lean();
        if (!user || user.isBlocked === true) return next(new Error("Authentication failed"));
        socket.data.userId = String(decoded.id);
        return next();
      } catch (err) {
        return next(new Error("Authentication failed"));
      }
    });

    io.on("connection", (socket) => {
      const userId = socket.data.userId;
      socket.join(`user:${userId}`);
      socket.on("subscribe_user", (requestedUserId) => {
        if (
          typeof requestedUserId === "string" &&
          mongoose.Types.ObjectId.isValid(requestedUserId) &&
          String(requestedUserId) === String(userId)
        ) {
          socket.join(`user:${userId}`);
        }
      });
    });

    app.set("io", io);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  }, 120000);

  afterAll(async () => {
    if (io) await new Promise((resolve) => io.close(() => resolve()));
    if (httpServer) await new Promise((resolve) => httpServer.close(() => resolve()));
    await disconnectMongoMemory();
  }, 120000);

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function connectSocket(token) {
    return await new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        auth: { token },
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  test("Booking accepted -> farmer receives existing socket event/payload", async () => {
    const { farmerToken, operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const farmerSocket = await connectSocket(farmerToken);
    const eventPromise = new Promise((resolve) =>
      farmerSocket.once("notification", (payload) => resolve(payload))
    );

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "accept" });

    expect(res.status).toBe(200);
    const payload = await Promise.race([
      eventPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("notification timeout")), 2000)),
    ]);
    expect(payload).toEqual(
      expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
        title: expect.any(String),
        bookingId: String(booking._id),
      })
    );
    farmerSocket.close();
  });

  test("Booking rejected -> farmer receives existing socket event", async () => {
    const { farmerToken, operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const farmerSocket = await connectSocket(farmerToken);
    const eventPromise = new Promise((resolve) =>
      farmerSocket.once("notification", (payload) => resolve(payload))
    );

    const res = await request(app)
      .post(`/api/v1/bookings/${booking._id}/respond`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ action: "reject" });

    expect(res.status).toBe(200);
    const payload = await Promise.race([
      eventPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("notification timeout")), 2000)),
    ]);
    expect(payload).toEqual(
      expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
        title: expect.any(String),
        bookingId: String(booking._id),
      })
    );
    farmerSocket.close();
  });

  test("Concurrent acceptance race -> one success, one conflict/error, single farmer notification", async () => {
    const { farmerToken, operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });

    const farmerSocket = await connectSocket(farmerToken);
    const notifications = [];
    farmerSocket.on("notification", (p) => notifications.push(p));

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/bookings/${booking._id}/respond`)
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({ action: "accept" }),
      request(app)
        .post(`/api/v1/bookings/${booking._id}/respond`)
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({ action: "accept" }),
    ]);

    const statuses = [a.status, b.status];
    expect(statuses).toContain(200);
    expect(statuses.some((s) => s >= 400)).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(notifications).toHaveLength(1);
    farmerSocket.close();
  });

  test("Room isolation -> farmer A does not receive farmer B event", async () => {
    const fA = await User.create({ phone: "+919111122201", role: "farmer", name: "Farmer A", landArea: 1 });
    const fB = await User.create({ phone: "+919111122202", role: "farmer", name: "Farmer B", landArea: 1 });
    const tA = jwt.sign({ id: String(fA._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const tB = jwt.sign({ id: String(fB._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const sA = await connectSocket(tA);
    const sB = await connectSocket(tB);
    const aEvents = [];
    const bEvents = [];
    sA.on("notification", (p) => aEvents.push(p));
    sB.on("notification", (p) => bEvents.push(p));

    io.to(`user:${String(fB._id)}`).emit("notification", {
      id: "x",
      message: "only b",
      type: "alert",
      title: "Alert",
      bookingId: null,
      isRead: false,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(aEvents).toHaveLength(0);
    expect(bEvents).toHaveLength(1);
    sA.close();
    sB.close();
  });

  test("Disconnect mid-job -> booking state remains valid (not broken)", async () => {
    const { operatorToken, farmer, operator, tractor } = await seedBookingFixtures();
    const booking = await createPendingBookingForFarmer({
      farmerId: farmer._id,
      operatorId: operator._id,
      tractorId: tractor._id,
    });
    booking.status = "accepted";
    booking.paymentStatus = "advance_paid";
    await booking.save();

    const operatorSocket = await connectSocket(operatorToken);
    operatorSocket.close();
    await new Promise((r) => setTimeout(r, 100));

    const latest = await Booking.findById(booking._id).lean();
    expect(["accepted", "confirmed", "in_progress", "completed", "payment_pending", "closed", "cancelled", "rejected"]).toContain(
      latest.status
    );
    expect(latest.status).toBe("accepted");
  });
});
