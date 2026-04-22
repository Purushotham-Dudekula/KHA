const mongoose = require("mongoose");
const Booking = require("../../src/models/booking.model");
const Review = require("../../src/models/review.model");
const User = require("../../src/models/user.model");
const {
  getOperatorReliabilityMetrics,
  syncOperatorRatingFromReviews,
  enrichOperatorPartitions,
} = require("../../src/services/operatorStats.service");

describe("operatorStats.service", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("getOperatorReliabilityMetrics returns null rates when no bookings", async () => {
    jest.spyOn(Booking, "find").mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const oid = new mongoose.Types.ObjectId();
    const m = await getOperatorReliabilityMetrics(oid);
    expect(m.reliability).toBe("average");
    expect(m.acceptanceRate).toBeNull();
  });

  test("getOperatorReliabilityMetrics marks reliable when thresholds met", async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push({
        status: "accepted",
        cancelledBy: null,
        createdAt: new Date(),
        respondedAt: new Date(Date.now() + 3600000),
      });
    }
    jest.spyOn(Booking, "find").mockReturnValue({ select: () => ({ lean: async () => rows }) });
    const m = await getOperatorReliabilityMetrics(new mongoose.Types.ObjectId());
    expect(m.reliability).toBe("reliable");
  });

  test("syncOperatorRatingFromReviews sets zero when no reviews", async () => {
    jest.spyOn(Review, "aggregate").mockResolvedValueOnce([]);
    jest.spyOn(User, "findByIdAndUpdate").mockResolvedValueOnce({});
    const r = await syncOperatorRatingFromReviews(new mongoose.Types.ObjectId());
    expect(r).toEqual({ averageRating: 0, reviewCount: 0 });
  });

  test("enrichOperatorPartitions merges metrics", async () => {
    const id = new mongoose.Types.ObjectId();
    jest.spyOn(User, "find").mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: id, averageRating: 4, reviewCount: 2, verificationStatus: "approved", aadhaarVerified: true }],
      }),
    });
    jest.spyOn(Booking, "find").mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const out = await enrichOperatorPartitions({
      onlineOperators: [{ _id: id, name: "A" }],
      offlineOperators: [],
    });
    expect(out.onlineOperators[0].reliability).toBeDefined();
    expect(out.onlineOperators[0].averageRating).toBe(4);
  });
});
