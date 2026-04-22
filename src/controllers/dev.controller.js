// Development-only routes. Disabled in production.
const User = require("../models/user.model");
const { sendSuccess } = require("../utils/apiResponse");

function getTest(_req, res) {
  return sendSuccess(res, 200, "Backend working", {});
}

async function createTestUser(req, res, next) {
  try {
    const user = await User.create({
      phone: "9999999999",
      name: "Test User",
    });

    return sendSuccess(res, 200, "Test user created.", { user });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getTest, createTestUser };

