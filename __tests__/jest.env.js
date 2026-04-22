// Runs before each test file (before app loads dotenv). dotenv does not override existing keys.
// prom-client collectDefaultMetrics() registers an interval that prevents Jest from exiting.
process.env.ENABLE_METRICS = "false";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "testsecret";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/testdb";
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || "true";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
// Avoid real Redis from .env: rateLimit.middleware + redis.service would keep ioredis handles open.
process.env.REDIS_URL = "";

// Prevent delayed Razorpay status polling timers from importing Razorpay
// after Jest has already torn down the environment.
//
// IMPORTANT: the app loads `.env` when importing `src/config/env.js`.
// If we only `delete` the keys here, dotenv will repopulate them.
// Setting to empty strings ensures dotenv won't override them (override=false),
// and `hasRazorpayKeys()` will evaluate to false.
process.env.RAZORPAY_KEY_ID = "";
process.env.RAZORPAY_KEY_SECRET = "";
