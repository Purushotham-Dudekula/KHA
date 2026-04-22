const { createRequest, createResponse } = require("node-mocks-http");
const mongoose = require("mongoose");
const { getAdminDashboardRevenueStats } = require("../../../src/controllers/adminDashboard.controller");
const Payment = require("../../../src/models/payment.model");
const Booking = require("../../../src/models/booking.model");

describe("Revenue Calculation Logic", () => {
  it("should throw an error if an unrecognized payment type is present in the database", async () => {
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn();

    // Mock Payment.findOne to simulate an unrecognized payment type in the DB
    jest.spyOn(Payment, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        type: "unrecognized_type",
      }),
    });

    // Call the revenue stats controller
    await getAdminDashboardRevenueStats(req, res, next);

    // Verify it explicitly threw an error and passed it to next()
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const error = next.mock.calls[0][0];
    expect(error.message).toBe("Unrecognized payment type found: unrecognized_type");

    jest.restoreAllMocks();
  });
});
