/**
 * user.service.js — findNearbyOperators with mocked User / Tractor / enrichOperatorPartitions.
 * Does not modify implementation.
 */
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../src/services/operatorStats.service", () => ({
  enrichOperatorPartitions: jest.fn(async (p) => ({
    onlineOperators: p.onlineOperators.map((o) => ({ ...o, enriched: true })),
    offlineOperators: p.offlineOperators.map((o) => ({ ...o, enriched: true })),
  })),
}));

const mockAggregate = jest.fn();
jest.mock("../../src/models/user.model", () => ({
  aggregate: (...args) => mockAggregate(...args),
}));

const mockLean = jest.fn();
jest.mock("../../src/models/tractor.model", () => ({
  find: jest.fn(() => ({
    select: jest.fn(() => ({
      lean: () => mockLean(),
    })),
  })),
}));

const mongoose = require("mongoose");
const Tractor = require("../../src/models/tractor.model");
const { logger } = require("../../src/utils/logger");
const { enrichOperatorPartitions } = require("../../src/services/operatorStats.service");
const { findNearbyOperators } = require("../../src/services/user.service");

describe("user.service findNearbyOperators", () => {
  const oid = () => new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    mockLean.mockReset();
    mockLean.mockResolvedValue([]);
  });

  test("throws when lat/lng/radius invalid", async () => {
    await expect(findNearbyOperators("x", 78.4, 10)).rejects.toThrow(/valid numbers/i);
    await expect(findNearbyOperators(17.4, "y", 10)).rejects.toThrow(/valid numbers/i);
    await expect(findNearbyOperators(17.4, 78.4, 0)).rejects.toThrow(/valid numbers/i);
    await expect(findNearbyOperators(17.4, 78.4, -1)).rejects.toThrow(/valid numbers/i);
  });

  test("radius above 50km logs warn and caps geo query", async () => {
    mockAggregate.mockResolvedValueOnce([]);
    await findNearbyOperators(17.4, 78.4, 80);

    expect(logger.warn).toHaveBeenCalledWith(
      "Nearby operators radius too large; capping for safety",
      expect.objectContaining({ requestedKm: 80, cappedKm: 50 })
    );
    expect(mockAggregate).toHaveBeenCalled();
    const pipeline = mockAggregate.mock.calls[0][0];
    const geo = pipeline[0].$geoNear;
    expect(geo.maxDistance).toBe(50 * 1000);
  });

  test("empty aggregate delegates to enrich with empty partitions", async () => {
    mockAggregate.mockResolvedValueOnce([]);
    const out = await findNearbyOperators(17.4, 78.4, 5);
    expect(enrichOperatorPartitions).toHaveBeenCalledWith({ onlineOperators: [], offlineOperators: [] });
    expect(out.onlineOperators).toEqual([]);
    expect(out.offlineOperators).toEqual([]);
  });

  test("dedupes duplicate operator ids from aggregate", async () => {
    const id = oid();
    mockAggregate.mockResolvedValueOnce([
      { _id: id, distance: 10, isOnline: true },
      { _id: id, distance: 99, isOnline: true },
    ]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: id,
        tractorType: "medium",
        brand: "B",
        model: "M",
        registrationNumber: "R1",
        machineryTypes: ["svc_code"],
        machinerySubTypes: [],
        tractorPhoto: "",
        verificationStatus: "approved",
        isAvailable: true,
      },
    ]);

    const out = await findNearbyOperators(17.4, 78.4, 10, "svc_code");
    expect(out.onlineOperators.length).toBe(1);
    expect(out.onlineOperators[0].enriched).toBe(true);
  });

  test("caps >50 operators and logs warn", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      _id: oid(),
      distance: i,
      isOnline: i % 2 === 0,
    }));
    mockAggregate.mockResolvedValueOnce(many);
    mockLean.mockResolvedValueOnce(
      many.map((o, i) => ({
        _id: new mongoose.Types.ObjectId(),
        operatorId: o._id,
        tractorType: "medium",
        brand: "B",
        model: "M",
        registrationNumber: `R${i}`,
        machineryTypes: ["any"],
        verificationStatus: "approved",
        isAvailable: true,
      }))
    );

    await findNearbyOperators(17.4, 78.4, 10, "any");
    expect(logger.warn).toHaveBeenCalledWith(
      "Nearby operators result set too large; capping for safety",
      expect.objectContaining({ total: 51, capped: 50 })
    );
  });

  test("skips tractors failing defensive filters and uses isVerified fallback on row", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["match_code"],
        verificationStatus: "rejected",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["match_code"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R2",
        tractorType: "medium",
        tractorPhoto: null,
        isVerified: true,
      },
    ]);

    const out = await findNearbyOperators(17.4, 78.4, 10, "match_code");
    const tractors = out.onlineOperators[0]?.tractors || [];
    expect(tractors.length).toBe(1);
    expect(String(tractors[0].registrationNumber)).toBe("R2");
  });

  test("skips duplicate tractor id for same operator", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: false }]);
    const tid = new mongoose.Types.ObjectId();
    const trow = {
      _id: tid,
      operatorId: opId,
      machineryTypes: ["x"],
      verificationStatus: "approved",
      isAvailable: true,
      brand: "B",
      model: "M",
      registrationNumber: "R",
      tractorType: "medium",
    };
    mockLean.mockResolvedValueOnce([trow, { ...trow, brand: "B2" }]);

    const out = await findNearbyOperators(17.4, 78.4, 10, "x");
    expect(out.offlineOperators[0].tractors.length).toBe(1);
  });

  test("operator with no _id in aggregate row is skipped", async () => {
    mockAggregate.mockResolvedValueOnce([{ distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([]);
    const out = await findNearbyOperators(17.4, 78.4, 10, null);
    expect(out.onlineOperators.length).toBe(0);
  });

  test("serviceType mismatch skips tractor (machineryTypes filter)", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["other_only"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "wanted_code");
    expect(out.onlineOperators.length).toBe(0);
  });

  test("machinerySubTypes array is mapped and normalized (ternary true branch)", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockImplementationOnce(() =>
      Promise.resolve([
        {
          _id: new mongoose.Types.ObjectId(),
          operatorId: opId,
          machineryTypes: ["svc_x"],
          machinerySubTypes: ["  SubA  ", "SubB"],
          verificationStatus: "approved",
          isAvailable: true,
          brand: "B",
          model: "M",
          registrationNumber: "R",
          tractorType: "medium",
        },
      ])
    );

    const out = await findNearbyOperators(17.4, 78.4, 10, "svc_x");
    const combined = [...(out.onlineOperators || []), ...(out.offlineOperators || [])];
    expect(combined[0].tractors[0].machinerySubTypes).toEqual(["suba", "subb"]);
  });

  test("aggregate rejection surfaces as error (DB failure)", async () => {
    mockAggregate.mockRejectedValueOnce(new Error("aggregate failed"));
    await expect(findNearbyOperators(17.4, 78.4, 10)).rejects.toThrow("aggregate failed");
  });

  test("Tractor.find chain failure surfaces as error", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    Tractor.find.mockImplementationOnce(() => {
      throw new Error("tractor query failed");
    });
    await expect(findNearbyOperators(17.4, 78.4, 10, "any")).rejects.toThrow("tractor query failed");
  });

  test("tractor row without operatorId is skipped (defensive)", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: null,
        machineryTypes: ["t"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["t"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R2",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "t");
    expect(out.onlineOperators[0].tractors.length).toBe(1);
  });

  test("operators with no eligible tractors after filtering return empty partitions", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["only_other"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "wanted");
    expect(out.onlineOperators.length).toBe(0);
    expect(out.offlineOperators.length).toBe(0);
    expect(enrichOperatorPartitions).toHaveBeenCalled();
  });

  test("sortByDistance treats missing distance as 0 when sorting", async () => {
    const a = oid();
    const b = oid();
    mockAggregate.mockResolvedValueOnce([
      { _id: a, isOnline: false },
      { _id: b, distance: 5, isOnline: false },
    ]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: a,
        machineryTypes: ["u"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R1",
        tractorType: "medium",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: b,
        machineryTypes: ["u"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R2",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "u");
    expect(out.offlineOperators.map((o) => String(o._id))).toEqual([String(a), String(b)]);
  });

  test("tractor document without _id is skipped (no tractorId)", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        operatorId: opId,
        machineryTypes: ["x"],
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "x");
    expect(out.onlineOperators.length).toBe(0);
  });

  test("non-array machineryTypes becomes empty list (no serviceType filter)", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: "not-an-array",
        machinerySubTypes: null,
        verificationStatus: "approved",
        isAvailable: true,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, null);
    expect(out.onlineOperators[0].tractors[0].machineryTypes).toEqual([]);
    expect(out.onlineOperators[0].tractors[0].machinerySubTypes).toEqual([]);
  });

  test("isAvailable false skips tractor before row build", async () => {
    const opId = oid();
    mockAggregate.mockResolvedValueOnce([{ _id: opId, distance: 1, isOnline: true }]);
    mockLean.mockResolvedValueOnce([
      {
        _id: new mongoose.Types.ObjectId(),
        operatorId: opId,
        machineryTypes: ["z"],
        verificationStatus: "approved",
        isAvailable: false,
        brand: "B",
        model: "M",
        registrationNumber: "R",
        tractorType: "medium",
      },
    ]);
    const out = await findNearbyOperators(17.4, 78.4, 10, "z");
    expect(out.onlineOperators.length).toBe(0);
  });

  test("enrichOperatorPartitions rejection propagates", async () => {
    mockAggregate.mockResolvedValueOnce([]);
    enrichOperatorPartitions.mockRejectedValueOnce(new Error("partition failed"));
    await expect(findNearbyOperators(1, 2, 5)).rejects.toThrow("partition failed");
  });
});
