const { createRequest, createResponse } = require("node-mocks-http");
const mongoose = require("mongoose");
const { createComplaint } = require("../../../src/controllers/complaint.controller");
const Booking = require("../../../src/models/booking.model");
const Complaint = require("../../../src/models/complaint.model");

describe("Complaint Validation Unit Tests", () => {
  describe("Operator Self-Complaint", () => {
    it("should return 403 when an operator files a complaint against their own booking", async () => {
      const operatorId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();

      const req = createRequest({
        method: "POST",
        user: { _id: operatorId },
        body: {
          bookingId: bookingId.toString(),
          message: "The farmer was rude",
          category: "General",
        },
      });
      const res = createResponse();
      const next = jest.fn();

      jest.spyOn(Booking, "findById").mockReturnValue({
        select: jest.fn().mockResolvedValue({
          _id: bookingId,
          farmer: new mongoose.Types.ObjectId(),
          operator: operatorId,
          equals: function (id) {
            return this._id.toString() === id.toString();
          },
        }),
      });

      await createComplaint(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      const error = next.mock.calls[0][0];
      expect(error.message).toBe("Operators cannot file a complaint against their own booking");
      expect(res.statusCode).toBe(403);

      jest.restoreAllMocks();
    });
  });
});
