let sentry = null;

function getSentry() {
  if (sentry) return sentry;
  try {
    sentry = require("@sentry/node");
    return sentry;
  } catch {
    return null;
  }
}

function initSentry(app) {
  const dsn = String(process.env.SENTRY_DSN || "").trim();
  if (!dsn) return null;
  const Sentry = getSentry();
  if (!Sentry) return null;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });

  if (app) {
    app.use(Sentry.Handlers.requestHandler());
  }
  return Sentry;
}

module.exports = { initSentry };

