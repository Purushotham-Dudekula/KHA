const express = require("express");
const { getQueueHealth } = require("../services/queueHealth.service");
const { getHealth } = require("../controllers/health.controller");

const router = express.Router();

router.get("/api/health", getHealth);

router.get("/api/v1/version", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({
      success: false,
      message: "Not found.",
    });
  }
  return res.json({
    version: "1.0.0",
    status: "stable",
    timestamp: new Date().toISOString(),
    queue: getQueueHealth(),
  });
});

module.exports = router;
