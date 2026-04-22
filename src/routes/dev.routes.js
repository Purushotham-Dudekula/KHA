// Development-only routes. Disabled in production.
const express = require("express");
const { getTest, createTestUser } = require("../controllers/dev.controller");
const { requireDevelopmentOnly } = require("../middleware/devOnly.middleware");

const router = express.Router();

router.use(requireDevelopmentOnly);
router.get("/test", getTest);
router.get("/test-user", createTestUser);

module.exports = router;

