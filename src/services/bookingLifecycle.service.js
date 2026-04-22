const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const { AppError } = require("../utils/AppError");
const { acquireLock, releaseLock } = require("./redisLock.service");

async function createBookingFlow({ userId, body, requestId }) {
  const {
    resolvedTractorId,
    bookingDate,
    time,
    bookingPayload,
    FARMER_DUPLICATE_BOOKING_STATUSES,
    userFacing,
    isFarmerActiveBookingDuplicateKey,
    isMachineSlotBookingDuplicateKey,
  } = body;

  const lockTtlMs = 30_000;
  const farmerLockKey = `lock:booking:create:farmer:${String(userId)}`;
  const slotLockKey = `lock:booking:slot:${String(resolvedTractorId)}:${bookingDate.toISOString().slice(0, 10)}:${String(time || "").trim()}`;
  const locks = [];
  const acquireOrHandle = async (key) => {
    const lock = await acquireLock(key, lockTtlMs);
    if (!lock.acquired) {
      throw new AppError("Booking is being processed. Please retry.", 409, {
        code: "BOOKING_LOCKED",
        retryable: true,
      });
    }
    locks.push({ key, token: lock.token });
  };
  // Acquire in deterministic order to avoid deadlocks.
  await acquireOrHandle(farmerLockKey);
  await acquireOrHandle(slotLockKey);

  let booking;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const dup = await Booking.findOne({
        farmer: userId,
        status: { $in: FARMER_DUPLICATE_BOOKING_STATUSES },
      })
        .session(session)
        .lean();
      if (dup) {
        throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
          code: userFacing.DUPLICATE_BOOKING.code,
          userTip: userFacing.DUPLICATE_BOOKING.userTip,
          retryable: userFacing.DUPLICATE_BOOKING.retryable,
        });
      }
      const [created] = await Booking.create([bookingPayload], { session });
      booking = created;
    });
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    if (isFarmerActiveBookingDuplicateKey(err)) {
      throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
        code: userFacing.DUPLICATE_BOOKING.code,
        userTip: userFacing.DUPLICATE_BOOKING.userTip,
        retryable: userFacing.DUPLICATE_BOOKING.retryable,
      });
    }
    if (isMachineSlotBookingDuplicateKey(err)) {
      throw new AppError(userFacing.SLOT_TAKEN.message, 409, {
        code: userFacing.SLOT_TAKEN.code,
        userTip: userFacing.SLOT_TAKEN.userTip,
        retryable: userFacing.SLOT_TAKEN.retryable,
      });
    }
    throw err;
  } finally {
    await session.endSession();
    // Release locks best-effort.
    for (const l of locks.reverse()) {
      try {
        await releaseLock(l.key, l.token);
      } catch {
        // ignore
      }
    }
  }

  return booking;
}

module.exports = {
  createBookingFlow,
};
