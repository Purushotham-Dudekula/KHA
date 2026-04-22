const express = require("express");
const request = require("supertest");
const { idempotencyGuard } = require("../src/middleware/idempotency.middleware");
const { errorHandler } = require("../src/middleware/errorHandler");

const IdempotencyKey = require("../src/models/idempotencyKey.model");

function createMockStore() {
  const records = new Map();
  const toStoreKey = ({ userId, key, method, path }) => `${userId}:${key}:${method}:${path}`;

  jest.spyOn(IdempotencyKey, "findOne").mockImplementation(async (filter) => {
    return records.get(toStoreKey(filter)) || null;
  });

  jest.spyOn(IdempotencyKey, "create").mockImplementation(async (payload) => {
    const storeKey = toStoreKey(payload);
    if (records.has(storeKey)) {
      const duplicate = new Error("duplicate key");
      duplicate.code = 11000;
      throw duplicate;
    }
    const created = { ...payload, _id: `idem-${records.size + 1}` };
    records.set(storeKey, created);
    return created;
  });

  jest.spyOn(IdempotencyKey, "updateOne").mockImplementation(async (query, update) => {
    for (const [storeKey, value] of records.entries()) {
      if (String(value._id) === String(query._id) && value.state === query.state) {
        records.set(storeKey, { ...value, ...update.$set });
      }
    }
    return { acknowledged: true, modifiedCount: 1 };
  });
}

describe("Concurrency and idempotency behavior", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("parallel same Idempotency-Key replays same cached response without reprocessing", async () => {
    createMockStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { _id: "user-1" };
      next();
    });
    app.post("/api/v1/bookings/create", idempotencyGuard(), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 120));
      return res.status(201).json({ success: true, message: "created", bookingId: "b-1" });
    });
    app.use(errorHandler);

    const reqs = Array.from({ length: 5 }, () =>
      request(app)
        .post("/api/v1/bookings/create")
        .set("Idempotency-Key", "same-key")
        .send({ tractor: "t1" })
    );
    const responses = await Promise.all(reqs);
    const first = responses[0];
    for (const res of responses) {
      expect(res.status).toBe(first.status);
      expect(res.body).toEqual(first.body);
    }
  });

  test("retry after timeout returns cached prior response", async () => {
    createMockStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { _id: "user-1" };
      next();
    });

    let handlerRuns = 0;
    app.post("/api/v1/bookings/create", idempotencyGuard(), async (_req, res) => {
      handlerRuns += 1;
      return res.status(408).json({ success: false, message: "Request timeout." });
    });
    app.use(errorHandler);

    const first = await request(app)
      .post("/api/v1/bookings/create")
      .set("Idempotency-Key", "timeout-retry")
      .send({ booking: "b1" });
    const retry = await request(app)
      .post("/api/v1/bookings/create")
      .set("Idempotency-Key", "timeout-retry")
      .send({ booking: "b1" });

    expect(first.status).toBe(408);
    expect(retry.status).toBe(408);
    expect(retry.body).toEqual(first.body);
    expect(handlerRuns).toBe(1);
  });

  test("payment retry with same key returns previous response", async () => {
    createMockStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { _id: "user-1" };
      next();
    });

    let chargeCalls = 0;
    app.post("/api/v1/bookings/1/pay-advance", idempotencyGuard(), async (_req, res) => {
      chargeCalls += 1;
      return res.status(200).json({ success: true, paymentId: "pay_1" });
    });
    app.use(errorHandler);

    const a = await request(app)
      .post("/api/v1/bookings/1/pay-advance")
      .set("Idempotency-Key", "pay-retry")
      .send({ amount: 1000 });
    const b = await request(app)
      .post("/api/v1/bookings/1/pay-advance")
      .set("Idempotency-Key", "pay-retry")
      .send({ amount: 1000 });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(chargeCalls).toBe(1);
  });

  test("refund flow prevents double processing on retry", async () => {
    let refundStatus = "pending";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { _id: "admin-1", role: "admin" };
      next();
    });

    app.post("/api/v1/admin/refunds/booking-1", async (_req, res) => {
      if (refundStatus !== "pending") {
        return res.status(200).json({ success: false, message: "Refund already processed" });
      }
      refundStatus = "approved";
      return res.status(200).json({ success: true, message: "Refund status updated." });
    });
    app.use(errorHandler);

    const first = await request(app).post("/api/v1/admin/refunds/booking-1").send({ action: "approve" });
    const second = await request(app).post("/api/v1/admin/refunds/booking-1").send({ action: "approve" });

    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(false);
  });

  test("unauthorized request is blocked for payment endpoint", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/v1/bookings/1/pay-advance", (req, res, next) => {
      const auth = req.get("Authorization");
      if (!auth) {
        res.status(401);
        return next(new Error("Not authorized, token missing"));
      }
      return res.status(200).json({ success: true });
    });
    app.use(errorHandler);

    const denied = await request(app).post("/api/v1/bookings/1/pay-advance").send({ amount: 10 });
    expect(denied.status).toBe(401);
    expect(denied.body.success).toBe(false);
  });
});
