const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Booking = require("../../../src/models/booking.model");

function buildBooking(status, overrides = {}) {
  return {
    farmer: new mongoose.Types.ObjectId(),
    operator: new mongoose.Types.ObjectId(),
    tractor: new mongoose.Types.ObjectId(),
    serviceType: "ploughing",
    date: new Date("2026-04-25T00:00:00.000Z"),
    time: "10:00",
    status,
    ...overrides,
  };
}

describe("cron booking status filters audit", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await Booking.deleteMany({});
  });

  test("bookingPaymentLock filter matches only expired payment_pending bookings", async () => {
    const now = new Date();
    const docs = await Booking.create([
      buildBooking("payment_pending", { lockExpiresAt: new Date(now.getTime() - 60_000) }),
      buildBooking("payment_pending", { lockExpiresAt: new Date(now.getTime() + 60_000) }),
      buildBooking("completed", { lockExpiresAt: new Date(now.getTime() - 60_000) }),
      buildBooking("cancelled", { lockExpiresAt: new Date(now.getTime() - 60_000) }),
    ]);

    const filter = {
      status: "payment_pending",
      lockExpiresAt: { $type: "date", $lt: now },
    };
    const matched = await Booking.find(filter).select("_id").lean();
    const matchedIds = matched.map((d) => String(d._id));

    expect(matchedIds).toEqual([String(docs[0]._id)]);
  });

  test("bookingReminder filter matches only pending/accepted/confirmed bookings", async () => {
    const docs = await Booking.create([
      buildBooking("pending"),
      buildBooking("accepted"),
      buildBooking("confirmed"),
      buildBooking("completed"),
      buildBooking("cancelled"),
    ]);

    const filter = {
      status: { $in: ["pending", "accepted", "confirmed"] },
    };
    const matched = await Booking.find(filter).select("_id").lean();
    const matchedIds = matched.map((d) => String(d._id)).sort();
    const expectedIds = [String(docs[0]._id), String(docs[1]._id), String(docs[2]._id)].sort();

    expect(matchedIds).toEqual(expectedIds);
  });

  test("paymentReconciliation booking stuck filter matches only stale payment_pending bookings", async () => {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const docs = await Booking.create([
      buildBooking("payment_pending"),
      buildBooking("payment_pending"),
      buildBooking("pending"),
      buildBooking("completed"),
    ]);
    await Booking.updateOne(
      { _id: docs[0]._id },
      { $set: { updatedAt: new Date(cutoff.getTime() - 60_000) } },
      { timestamps: false }
    );
    await Booking.updateOne(
      { _id: docs[1]._id },
      { $set: { updatedAt: new Date(cutoff.getTime() + 60_000) } },
      { timestamps: false }
    );
    await Booking.updateOne(
      { _id: docs[2]._id },
      { $set: { updatedAt: new Date(cutoff.getTime() - 60_000) } },
      { timestamps: false }
    );
    await Booking.updateOne(
      { _id: docs[3]._id },
      { $set: { updatedAt: new Date(cutoff.getTime() - 60_000) } },
      { timestamps: false }
    );

    const filter = {
      status: "payment_pending",
      updatedAt: { $lt: cutoff },
    };
    const matched = await Booking.find(filter).select("_id").lean();
    const matchedIds = matched.map((d) => String(d._id));

    expect(matchedIds).toEqual([String(docs[0]._id)]);
  });
});
