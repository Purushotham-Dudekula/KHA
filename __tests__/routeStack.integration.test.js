const request = require("supertest");
jest.mock("../src/middleware/auth.middleware", () => ({
  protect: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011", role: "farmer", isBlocked: false };
    next();
  },
  requireRole:
    (...roles) =>
    (req, res, next) => {
      if (roles.includes(req.user?.role)) return next();
      res.status(403);
      return next(new Error("Forbidden"));
    },
}));

jest.mock("../src/middleware/validate.middleware", () => ({
  validate: () => (_req, _res, next) => next(),
}));

jest.mock("../src/middleware/serviceValidation.middleware", () => ({
  validateBookingServiceType: (_req, _res, next) => next(),
  validateTractorServiceTypes: (_req, _res, next) => next(),
}));

const mockBookingState = new Map();
const mockCalls = { create: 0, payAdvance: 0, payRemaining: 0 };

jest.mock("../src/controllers/booking/booking.index.js", () => ({
  createBooking: async (req, res) => {
    mockCalls.create += 1;
    const id = `b-${mockCalls.create}`;
    mockBookingState.set(id, { id, paid: false });
    return res
      .status(201)
      .json({ success: true, message: "Booking created successfully.", data: { booking: { _id: id, status: "pending" } } });
  },
  respondToBooking: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  payAdvance: async (req, res) => {
    mockCalls.payAdvance += 1;
    const row = mockBookingState.get(req.params.id);
    if (!row) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    row.paid = true;
    return res.status(200).json({
      success: true,
      message: "Advance payment recorded successfully.",
      data: {
        booking: { _id: req.params.id, paymentStatus: "advance_paid" },
        payment: { paymentId: "pay_advance_1", status: "PENDING" },
      },
    });
  },
  startJob: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  completeJob: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  payRemaining: async (_req, res) => {
    mockCalls.payRemaining += 1;
    return res.status(408).json({ success: false, message: "Request timeout." });
  },
  updateBookingProgress: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  cancelBooking: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  getBookingRefundPreview: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  getBookingDetails: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  getBookingInvoice: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  listFarmerBookings: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  listOperatorBookings: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  listMyOperatorBookings: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  listMyFarmerBookings: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  estimateBooking: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
  trackBooking: async (_req, res) => res.status(200).json({ success: true, message: "ok", data: {} }),
}));

jest.mock("../src/models/idempotencyKey.model", () => {
  const records = new Map();
  const keyOf = (f) => `${f.userId}:${f.key}:${f.method}:${f.path}`;
  return {
    findOne: jest.fn(async (filter) => records.get(keyOf(filter)) || null),
    create: jest.fn(async (payload) => {
      const k = keyOf(payload);
      if (records.has(k)) {
        const e = new Error("duplicate");
        e.code = 11000;
        throw e;
      }
      const row = { ...payload, _id: `idem-${records.size + 1}` };
      records.set(k, row);
      return row;
    }),
    updateOne: jest.fn(async (query, update) => {
      for (const [k, v] of records.entries()) {
        if (String(v._id) === String(query._id) && v.state === query.state) {
          records.set(k, { ...v, ...update.$set });
        }
      }
      return { acknowledged: true, modifiedCount: 1 };
    }),
  };
});

describe("Route stack integration", () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    mockCalls.create = 0;
    mockCalls.payAdvance = 0;
    mockCalls.payRemaining = 0;
    mockBookingState.clear();
    process.env.NODE_ENV = "development";
    process.env.MONGO_URI = "mongodb://localhost:27017/test";
    process.env.JWT_SECRET = "test-secret";
    process.env.JWT_EXPIRES_IN = "5m";
    process.env.CORS_ORIGIN = "http://localhost:3000";
    process.env.DEV_ROUTE_SECRET = "dev-secret";
    const { validateEnv } = require("../src/config/env");
    validateEnv();
    app = require("../src/app").createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("booking then advance payment through real route stack", async () => {
    const created = await request(app).post("/api/v1/bookings/create").send({ serviceType: "rotavator" });
    expect(created.status).toBe(201);
    const bookingId = created.body?.data?.booking?._id;
    expect(bookingId).toBeTruthy();

    const paid = await request(app)
      .post(`/api/v1/bookings/${bookingId}/pay-advance`)
      .set("Idempotency-Key", "flow-pay-1")
      .send({ paymentMethod: "upi" });

    expect(paid.status).toBe(200);
    expect(paid.body.success).toBe(true);
    expect(mockCalls.payAdvance).toBe(1);
  });

  test("retry after timeout returns prior response via idempotency", async () => {
    const first = await request(app)
      .post("/api/v1/bookings/some-id/pay-remaining")
      .set("Idempotency-Key", "timeout-flow-1")
      .send({ paymentMethod: "upi" });
    const retry = await request(app)
      .post("/api/v1/bookings/some-id/pay-remaining")
      .set("Idempotency-Key", "timeout-flow-1")
      .send({ paymentMethod: "upi" });

    expect(first.status).toBe(408);
    expect(retry.status).toBe(408);
    expect(retry.body).toEqual(first.body);
    expect(mockCalls.payRemaining).toBe(1);
  });

  test("admin route unauthorized without token", async () => {
    const res = await request(app).get("/api/v1/admin/me");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
