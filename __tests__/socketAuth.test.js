const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const User = require("../src/models/user.model");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
} = require("./helpers/mongoMemoryHarness");

describe("socket.io authentication", () => {
  let httpServer;
  let io;
  let baseUrl;
  let user;
  let otherUser;

  async function startSocketServer() {
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: "*" } });

    io.use(async (socket, next) => {
      try {
        const auth = socket.handshake.auth || {};
        const header = socket.handshake.headers?.authorization;
        const token =
          (typeof auth.token === "string" && auth.token) ||
          (typeof header === "string" && header.startsWith("Bearer ")
            ? header.slice(7).trim()
            : null);

        if (!token) {
          return next(new Error("Authentication required"));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.scope === "admin" || !decoded.id) {
          return next(new Error("Invalid token"));
        }

        const uid = String(decoded.id);
        if (!mongoose.Types.ObjectId.isValid(uid)) {
          return next(new Error("Invalid token"));
        }

        const dbUser = await User.findById(uid).select("isBlocked").lean();
        if (!dbUser || dbUser.isBlocked === true) {
          return next(new Error("Authentication failed"));
        }

        socket.data.userId = uid;
        return next();
      } catch (err) {
        if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
          return next(new Error("Authentication failed"));
        }
        return next(err);
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

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  async function stopSocketServer() {
    if (io) {
      await new Promise((resolve) => io.close(() => resolve()));
      io = null;
    }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      httpServer = null;
    }
  }

  async function connectWithToken(token) {
    return await new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        auth: token ? { token } : {},
      });

      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => {
        socket.close();
        reject(err);
      });
    });
  }

  beforeAll(async () => {
    await connectMongoMemory();
  }, 120000);

  afterAll(async () => {
    await stopSocketServer();
    await disconnectMongoMemory();
  }, 120000);

  beforeEach(async () => {
    await resetDatabase();
    await startSocketServer();

    user = await User.create({
      phone: "+919900000101",
      role: "farmer",
      name: "Socket User",
      verificationStatus: "approved",
    });
    otherUser = await User.create({
      phone: "+919900000102",
      role: "farmer",
      name: "Other User",
      verificationStatus: "approved",
    });
  });

  afterEach(async () => {
    await stopSocketServer();
  });

  test("connection with valid user JWT should connect successfully", async () => {
    const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const socket = await connectWithToken(token);

    expect(socket.connected).toBe(true);
    const ownRoom = io.sockets.adapter.rooms.get(`user:${String(user._id)}`);
    expect(ownRoom?.has(socket.id)).toBe(true);

    socket.close();
  });

  test("connection with no token should be rejected", async () => {
    await expect(connectWithToken(null)).rejects.toMatchObject({
      message: "Authentication required",
    });
  });

  test("connection with expired JWT should be rejected", async () => {
    const expiredToken = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: -10 });

    await expect(connectWithToken(expiredToken)).rejects.toMatchObject({
      message: "Authentication failed",
    });
  });

  test("connection with admin-scoped JWT should be rejected", async () => {
    const adminScopedToken = jwt.sign(
      { id: String(user._id), scope: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await expect(connectWithToken(adminScopedToken)).rejects.toMatchObject({
      message: "Invalid token",
    });
  });

  test("cross-user room subscription attempt should be blocked", async () => {
    const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const socket = await connectWithToken(token);

    socket.emit("subscribe_user", String(otherUser._id));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const ownRoom = io.sockets.adapter.rooms.get(`user:${String(user._id)}`);
    const otherRoom = io.sockets.adapter.rooms.get(`user:${String(otherUser._id)}`);

    expect(ownRoom?.has(socket.id)).toBe(true);
    expect(otherRoom?.has(socket.id) || false).toBe(false);

    socket.close();
  });
});
