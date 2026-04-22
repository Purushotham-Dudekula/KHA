const mongoose = require("mongoose");
const {
  getOperatorEarnings,
  getOperatorEarningsHistory,
  updateOperatorLocation,
  updateOperatorBankDetails,
} = require("../../src/controllers/operator.controller");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function oid(v = "507f191e810c19729de860ea") {
  return new mongoose.Types.ObjectId(v);
}

describe("operator.controller ultra coverage", () => {
  test("role protection branches", async () => {
    const next = jest.fn();
    const req = { user: { role: "farmer", _id: oid() }, body: {}, query: {} };
    await updateOperatorBankDetails(req, makeRes(), next);
    await getOperatorEarnings(req, makeRes(), next);
    await updateOperatorLocation(req, makeRes(), next);
    await getOperatorEarningsHistory(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test("location validation branches", async () => {
    const next = jest.fn();
    await updateOperatorLocation(
      { user: { role: "operator", _id: oid() }, body: { latitude: "99", longitude: "77" } },
      makeRes(),
      next
    );
    await updateOperatorLocation(
      { user: { role: "operator", _id: oid() }, body: { latitude: "18", longitude: "999" } },
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledTimes(2);
  });
});
