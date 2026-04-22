const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../../src/models/user.model");
const Tractor = require("../../src/models/tractor.model");
const Service = require("../../src/models/service.model");
const Commission = require("../../src/models/commission.model");
const Booking = require("../../src/models/booking.model");
const { invalidateServiceCache } = require("../../src/services/serviceCache.service");

let mongoReplSet;

function setTestEnv() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "testsecret";
  process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
  process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || "true";
}

async function connectMongoMemory() {
  setTestEnv();
  mongoReplSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = mongoReplSet.getUri();
  process.env.MONGO_URI = uri;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);
}

async function disconnectMongoMemory() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch {
    // ignore
  }
  if (mongoReplSet) {
    await mongoReplSet.stop();
    mongoReplSet = null;
  }
}

/** Call from Jest globalTeardown: Mongo + optional Redis so the runner exits cleanly without forceExit. */
async function teardownAllTestResources() {
  await disconnectMongoMemory();
  try {
    const { closeRedis } = require("../../src/services/redis.service");
    await closeRedis();
  } catch {
    // ignore
  }
}

async function resetDatabase() {
  await mongoose.connection.dropDatabase();
}

/**
 * Seeds operator + farmer + tractor + service + commission. Returns ids and farmer token.
 */
async function seedBookingFixtures() {
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
    phone: "+919999900001",
    role: "operator",
    verificationStatus: "approved",
    name: "Op Test",
    landArea: 0,
  });

  const farmer = await User.create({
    phone: "+919999900002",
    role: "farmer",
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

  const farmerToken = jwt.sign({ id: String(farmer._id) }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

  const operatorToken = jwt.sign({ id: String(operator._id) }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

  return {
    farmer,
    operator,
    tractor,
    farmerToken,
    operatorToken,
  };
}

function futureBookingDate() {
  const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

/**
 * Creates a pending booking via DB (avoids full HTTP create when only payment state is needed).
 */
async function createPendingBookingForFarmer({ farmerId, operatorId, tractorId }) {
  const bookingDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  return Booking.create({
    farmer: farmerId,
    operator: operatorId,
    tractor: tractorId,
    status: "pending",
    paymentStatus: "no_payment",
    landArea: 5,
    serviceType: "int_test_svc",
    date: bookingDate,
    time: "10:00",
    address: "Test address",
    baseAmount: 2500,
    gstAmount: 0,
    platformFee: 250,
    totalAmount: 2750,
    estimatedAmount: 2750,
    finalAmount: 2750,
    advancePayment: 825,
    advanceAmount: 825,
    remainingAmount: 1925,
  });
}

module.exports = {
  connectMongoMemory,
  disconnectMongoMemory,
  teardownAllTestResources,
  resetDatabase,
  seedBookingFixtures,
  futureBookingDate,
  createPendingBookingForFarmer,
};
