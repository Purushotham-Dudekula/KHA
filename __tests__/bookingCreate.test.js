const { createBooking } = require("../src/controllers/booking/booking.index.js");

function makeRes() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(_body) {
      return this;
    },
  };
}

describe("Booking creation", () => {
  test("rejects when user is not a farmer", async () => {
    const req = {
      user: { role: "operator", _id: "507f1f77bcf86cd799439011" },
      body: {},
    };
    const res = makeRes();
    const next = jest.fn();

    await createBooking(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/Only farmers can create bookings/i);
  });
});

