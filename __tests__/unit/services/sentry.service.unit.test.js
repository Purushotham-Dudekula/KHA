describe("sentry.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("initSentry -> null when DSN missing", () => {
    delete process.env.SENTRY_DSN;
    const { initSentry } = require("../../../src/services/sentry.service");
    expect(initSentry()).toBeNull();
  });

  test("initSentry -> null when @sentry/node not installed", () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    jest.doMock("@sentry/node", () => {
      throw new Error("not installed");
    });
    const { initSentry } = require("../../../src/services/sentry.service");
    expect(initSentry()).toBeNull();
  });

  test("initSentry -> initializes and registers request handler", () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    jest.doMock("@sentry/node", () => ({
      init: jest.fn(),
      Handlers: { requestHandler: () => (_req, _res, next) => next() },
    }));
    const app = { use: jest.fn() };
    const { initSentry } = require("../../../src/services/sentry.service");
    const S = initSentry(app);
    expect(S).toBeTruthy();
    expect(app.use).toHaveBeenCalled();
  });
});

