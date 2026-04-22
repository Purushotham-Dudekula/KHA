describe("booking.controller audit auth/validation edges", () => {
  function makeRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  test("critical endpoints reject wrong roles and invalid ids", async () => {
    const c = require("../../src/controllers/booking/booking.index.js");
    const next = jest.fn();

    await c.startJob({ user: { role: "farmer" }, params: { id: "507f1f77bcf86cd799439011" } }, makeRes(), next);
    await c.completeJob({ user: { role: "farmer" }, params: { id: "507f1f77bcf86cd799439011" } }, makeRes(), next);
    await c.respondToBooking({ user: { role: "operator" }, params: { id: "bad" }, body: { action: "accept" } }, makeRes(), next);
    await c.getBookingDetails({ user: { _id: "u1" }, params: { id: "bad" } }, makeRes(), next);
    await c.trackBooking({ user: { _id: "u1" }, params: { id: "bad" } }, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });
});

