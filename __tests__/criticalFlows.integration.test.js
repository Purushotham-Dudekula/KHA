const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { sendSuccess } = require("../src/utils/apiResponse");
const { errorHandler } = require("../src/middleware/errorHandler");
const { protect } = require("../src/middleware/auth.middleware");
const { verifyPayment } = require("../src/services/payment.service");

describe("Critical flow integrations", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("booking creation: success + duplicate", async () => {
    const app = express();
    app.use(express.json());

    app.post("/api/v1/bookings/create", (req, res, next) => {
      try {
        if (req.body?.duplicate === true) {
          res.status(409);
          throw new Error("Duplicate active booking");
        }
        return sendSuccess(res, 201, "Booking created successfully.", {
          booking: { id: "booking-1", status: "pending" },
        });
      } catch (error) {
        return next(error);
      }
    });
    app.use(errorHandler);

    const ok = await request(app).post("/api/v1/bookings/create").send({ duplicate: false });
    expect(ok.status).toBe(201);
    expect(ok.body.success).toBe(true);

    const dup = await request(app).post("/api/v1/bookings/create").send({ duplicate: true });
    expect(dup.status).toBe(409);
    expect(dup.body.success).toBe(false);
  });

  test("payment verification: dev bypass works only in development", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/v1/payments/verify", async (req, res, next) => {
      try {
        const out = await verifyPayment(req.body || {});
        return res.status(200).json(out);
      } catch (error) {
        return next(error);
      }
    });
    app.use(errorHandler);

    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEV_PAYMENT = "true";
    const dev = await request(app).post("/api/v1/payments/verify").send({});
    expect(dev.status).toBe(200);
    expect(dev.body.verified).toBe(true);
    expect(dev.body.message).toBe("DEV MODE BYPASS");

    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "";
    process.env.RAZORPAY_KEY_SECRET = "";
    const prod = await request(app).post("/api/v1/payments/verify").send({});
    expect(prod.status).toBe(500);
    expect(prod.body.success).toBe(false);
  });

  test("unauthorized access is blocked", async () => {
    const app = express();
    app.use(express.json());
    app.get("/api/v1/protected", protect, (req, res) => {
      return sendSuccess(res, 200, "ok", { userId: String(req.user._id) });
    });
    app.use(errorHandler);

    const noToken = await request(app).get("/api/v1/protected");
    expect(noToken.status).toBe(401);
    expect(noToken.body.success).toBe(false);

    process.env.JWT_SECRET = "test-secret";
    const token = jwt.sign({ id: "507f1f77bcf86cd799439011" }, process.env.JWT_SECRET, {
      expiresIn: "5m",
    });
    jest.spyOn(require("../src/models/user.model"), "findById").mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        isBlocked: false,
      }),
    });
    const withToken = await request(app).get("/api/v1/protected").set("Authorization", `Bearer ${token}`);
    expect(withToken.status).toBe(200);
    expect(withToken.body.success).toBe(true);
  });
});
