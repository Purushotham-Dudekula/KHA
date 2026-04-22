describe("sentry.service", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  test("initSentry returns null without DSN", () => {
    const { initSentry } = require("../../src/services/sentry.service");
    expect(initSentry(null)).toBeNull();
  });
});
