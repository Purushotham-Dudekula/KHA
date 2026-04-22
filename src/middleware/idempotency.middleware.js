const crypto = require("crypto");
const IdempotencyKey = require("../models/idempotencyKey.model");
const { getRedisClient } = require("../services/redis.service");
const { logger } = require("../utils/logger");

const TTL_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS_WAIT_MS = 5000;
const IN_PROGRESS_POLL_MS = 100;

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function buildRequestHash(req) {
  const payload = {
    method: req.method,
    path: req.originalUrl.split("?")[0],
    query: req.query || {},
    body: req.body || {},
  };
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function buildRedisKey({ userId, key, method, path }) {
  return `idem:${userId}:${method}:${path}:${key}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idempotencyGuard() {
  return async (req, res, next) => {
    try {
      const rawKey = req.get("Idempotency-Key");
      const key = rawKey ? String(rawKey).trim() : "";
      if (!key) return next();
      if (!req.user?._id) return next();

      const method = String(req.method || "").toUpperCase();
      const path = req.originalUrl.split("?")[0];
      const userId = req.user._id;
      const requestHash = buildRequestHash(req);
      const filter = { userId, key, method, path };
      const redis = getRedisClient();
      const redisKey = buildRedisKey({ userId, key, method, path });

      if (redis) {
        try {
          const cached = await redis.get(redisKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed?.requestHash === requestHash && Number.isFinite(parsed?.statusCode)) {
              return res.status(parsed.statusCode).json(parsed.responseBody);
            }
          }
        } catch (error) {
          logger.warn("Redis idempotency cache read failed; falling back to Mongo idempotency store", {
            key: redisKey,
            message: error?.message || String(error),
          });
        }
      }

      let record = await IdempotencyKey.findOne(filter);
      let createdFresh = false;
      if (!record) {
        try {
          record = await IdempotencyKey.create({
            ...filter,
            requestHash,
            state: "in_progress",
            expiresAt: new Date(Date.now() + TTL_MS),
          });
          createdFresh = true;
        } catch (e) {
          if (e && (e.code === 11000 || e.code === 11001)) {
            record = await IdempotencyKey.findOne(filter);
          } else {
            throw e;
          }
        }
      }

      if (!record) {
        res.status(500);
        throw new Error("Unable to process idempotency key.");
      }

      if (record.requestHash !== requestHash) {
        res.status(409);
        throw new Error("Idempotency-Key is already used for a different request.");
      }

      if (record.state === "completed") {
        const statusCode = Number(record.statusCode) || 200;
        return res.status(statusCode).json(record.responseBody);
      }

      if (record.state === "in_progress" && !createdFresh) {
        const deadline = Date.now() + IN_PROGRESS_WAIT_MS;
        while (Date.now() < deadline) {
          await sleep(IN_PROGRESS_POLL_MS);
          const latest = await IdempotencyKey.findOne(filter);
          if (latest?.requestHash !== requestHash) {
            res.status(409);
            throw new Error("Idempotency-Key is already used for a different request.");
          }
          if (latest?.state === "completed") {
            const statusCode = Number(latest.statusCode) || 200;
            return res.status(statusCode).json(latest.responseBody);
          }
        }
        return res.status(202).json({
          success: true,
          message: "Request with same Idempotency-Key is still in progress.",
        });
      }

      let capturedBody;
      let bodyCaptured = false;
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = (body) => {
        capturedBody = body;
        bodyCaptured = true;
        return originalJson(body);
      };

      res.send = (body) => {
        if (!bodyCaptured) {
          capturedBody = body;
          bodyCaptured = true;
        }
        return originalSend(body);
      };

      let persisted = false;
      res.on("finish", async () => {
        if (persisted) return;
        persisted = true;
        try {
          await IdempotencyKey.updateOne(
            { _id: record._id, state: "in_progress" },
            {
              $set: {
                state: "completed",
                statusCode: res.statusCode,
                responseBody: capturedBody ?? null,
                expiresAt: new Date(Date.now() + TTL_MS),
              },
            }
          );
          if (redis) {
            try {
              await redis.set(
                redisKey,
                JSON.stringify({
                  requestHash,
                  statusCode: res.statusCode,
                  responseBody: capturedBody ?? null,
                }),
                "PX",
                TTL_MS
              );
            } catch (error) {
              logger.warn("Redis idempotency cache write failed; Mongo state retained", {
                key: redisKey,
                message: error?.message || String(error),
              });
            }
          }
        } catch (error) {
          logger.warn("Idempotency persistence update failed", {
            message: error?.message || String(error),
          });
        }
      });

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { idempotencyGuard };
