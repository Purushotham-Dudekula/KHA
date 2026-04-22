const mongoose = require("mongoose");
const { createRequest, createResponse } = require("node-mocks-http");
const Payment = require("../../../src/models/payment.model");
const { getAdminDashboardRevenueStats } = require("../../../src/controllers/adminDashboard.controller");

describe("Payment Type Validation & Revenue Guard Tests", () => {
  describe("Model Validation", () => {
    it("should throw a validation error for an unrecognized payment type", async () => {
      const payment = new Payment({
        bookingId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        amount: 100,
        type: "invalid_type",
        paymentMethod: "upi",
        status: "PENDING",
      });

      let error;
      try {
        await payment.validate();
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.errors.type).toBeDefined();
      expect(error.errors.type.message).toContain("is not a valid payment type!");
    });

    it("should pass validation for recognized payment types", async () => {
      const validTypes = ["advance", "remaining", "full", "refund"];
      for (const type of validTypes) {
        const payment = new Payment({
          bookingId: new mongoose.Types.ObjectId(),
          userId: new mongoose.Types.ObjectId(),
          amount: 100,
          type: type,
          paymentMethod: "upi",
          status: "PENDING",
        });
        await expect(payment.validate()).resolves.toBeUndefined();
      }
    });
  });

  describe("Revenue Calculation Guard", () => {
    it("should throw an error in getAdminDashboardRevenueStats if an unrecognized payment type exists", async () => {
      const req = createRequest();
      const res = createResponse();
      const next = jest.fn();

      // Mock Payment.findOne to return an "unrecognized" payment
      jest.spyOn(Payment, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ type: "ghost_payment" }),
      });

      await getAdminDashboardRevenueStats(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      const error = next.mock.calls[0][0];
      expect(error.message).toBe("Unrecognized payment type found: ghost_payment");

      jest.restoreAllMocks();
    });
  });
});
