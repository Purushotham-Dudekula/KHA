let promClient = null;

function getProm() {
  if (promClient) return promClient;
  try {
    promClient = require("prom-client");
    return promClient;
  } catch {
    return null;
  }
}

function metricsMiddleware() {
  const enabled = String(process.env.ENABLE_METRICS || "true").trim().toLowerCase() !== "false";
  if (!enabled) return { middleware: (_req, _res, next) => next(), handler: null };

  const prom = getProm();
  if (!prom) return { middleware: (_req, _res, next) => next(), handler: null };

  const register = prom.register;
  prom.collectDefaultMetrics({ register });

  const httpRequestsTotal = new prom.Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
  });

  const httpRequestDurationMs = new prom.Histogram({
    name: "http_request_duration_ms",
    help: "HTTP request duration in ms",
    labelNames: ["method", "route", "status"],
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  });

  const middleware = (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const route = req.route?.path ? String(req.route.path) : String(req.path || "");
      const status = String(res.statusCode);
      httpRequestsTotal.inc({ method: req.method, route, status });
      httpRequestDurationMs.observe({ method: req.method, route, status }, Date.now() - start);
    });
    next();
  };

  const handler = async (_req, res) => {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  };

  return { middleware, handler };
}

module.exports = { metricsMiddleware };

