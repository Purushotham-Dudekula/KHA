const mongoose = require("mongoose");
const { scheduleBookingReminders } = require("../../../src/jobs/bookingReminder.cron");
const Booking = require("../../../src/models/booking.model");
const cron = require("node-cron");

jest.mock("node-cron", () => ({
  schedule: jest.fn(),
}));

describe("Booking Reminder Cron Unit Tests", () => {
  it("should target only non-terminal states", async () => {
    // We are verifying that the cron schedule callback was defined and we can inspect the code/filter
    // Or we can mock Booking.find and trigger the cron job callback directly.

    let cronCallback;
    cron.schedule.mockImplementation((pattern, callback) => {
      cronCallback = callback;
    });

    scheduleBookingReminders({});

    expect(cron.schedule).toHaveBeenCalledWith("* * * * *", expect.any(Function));

    const findSpy = jest.spyOn(Booking, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    
    const countSpy = jest.spyOn(Booking, "countDocuments").mockResolvedValue(0);

    // Trigger the callback
    await cronCallback();

    expect(countSpy).toHaveBeenCalledWith({
      status: { $nin: ["completed", "cancelled", "rejected", "closed"] },
    });
    
    expect(findSpy).toHaveBeenCalledWith({
      status: { $nin: ["completed", "cancelled", "rejected", "closed"] },
    });

    jest.restoreAllMocks();
  });
});
