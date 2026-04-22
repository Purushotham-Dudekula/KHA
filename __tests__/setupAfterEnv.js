/**
 * Per test file: release DB/Redis handles so Jest can exit without --forceExit.
 */
const mongoose = require("mongoose");

// Keep this aligned with `jest.config.js` (testTimeout: 120000).
// GitHub Actions runners are slower; 30s can cause flaky timeouts.
jest.setTimeout(120000);

let consoleLogSpy;
let consoleInfoSpy;
let consoleWarnSpy;
beforeAll(() => {
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "test") {
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  }
});

afterAll(async () => {
  try {
    const { closeRedis } = require("../src/services/redis.service");
    await closeRedis();
  } catch {
    // ignore
  }
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch {
    // ignore
  }
  consoleLogSpy?.mockRestore();
  consoleInfoSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
});
