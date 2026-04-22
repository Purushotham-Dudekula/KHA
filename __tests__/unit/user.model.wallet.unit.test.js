const User = require("../../src/models/user.model");

describe("user.model wallet default", () => {
  test("wallet defaults to 0 when not provided", () => {
    const user = new User({
      phone: "+919999000001",
      role: "farmer",
      name: "Wallet Default User",
    });

    expect(user.wallet).toBe(0);
  });
});
