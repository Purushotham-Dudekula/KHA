/**
 * queueHealth.service — success / edge cases (Redis mocked via NODE_ENV=test).
 */
const { getQueueHealth, bullmqAvailable } = require("../../src/services/queueHealth.service");

describe("queueHealth.service", () => {
  test("getQueueHealth returns structured object", () => {
    const h = getQueueHealth();
    expect(h).toEqual(
      expect.objectContaining({
        bullmqAvailable: expect.any(Boolean),
        redisConfigured: expect.any(Boolean),
        redisConnected: expect.any(Boolean),
      })
    );
  });

  test("bullmqAvailable is boolean (package present in this repo)", () => {
    expect(typeof bullmqAvailable()).toBe("boolean");
  });
});
