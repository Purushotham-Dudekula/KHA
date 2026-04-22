jest.mock("../../../src/services/serviceCache.service", () => ({
  getAllServicesCached: jest.fn(),
  getServiceByCodeCached: jest.fn(),
}));

jest.mock("../../../src/models/pricing.model", () => ({
  findOne: jest.fn(),
}));

jest.mock("../../../src/models/tractor.model", () => ({
  findOne: jest.fn(),
}));

jest.mock("../../../src/utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const mongoose = require("mongoose");
const Tractor = require("../../../src/models/tractor.model");
const Pricing = require("../../../src/models/pricing.model");
const { getAllServicesCached, getServiceByCodeCached } = require("../../../src/services/serviceCache.service");
const {
  validateTractorServiceTypes,
  validateBookingServiceType,
} = require("../../../src/middleware/serviceValidation.middleware");

function mockPricingLean(doc) {
  Pricing.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue(doc),
  });
}

describe("serviceValidation.middleware", () => {
  const tid = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("validateTractorServiceTypes", () => {
    test("no machineryTypes or machinerySubTypes calls next()", async () => {
      const req = { body: {} };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    test("empty machineryTypes array returns 400", async () => {
      const req = { body: { machineryTypes: [] } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("machineryTypes must exist in catalog when catalog non-empty", async () => {
      getAllServicesCached.mockResolvedValue([{ code: "plough" }]);
      const req = { body: { machineryTypes: ["bad_code"] } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("valid machineryTypes normalizes and passes", async () => {
      getAllServicesCached.mockResolvedValue([{ code: "plough" }]);
      const req = { body: { machineryTypes: [" Plough "] } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(req.body.machineryTypes).toEqual(["plough"]);
      expect(next).toHaveBeenCalledWith();
    });

    test("machinerySubTypes without valid tractor id returns 400", async () => {
      const req = { params: { id: "bad" }, body: { machinerySubTypes: ["a"] } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("tractor not found returns 404", async () => {
      Tractor.findOne.mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });
      const req = { params: { id: tid.toString() }, body: { machinerySubTypes: ["a"] } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("invalid subtypes vs service definition returns 400", async () => {
      Tractor.findOne.mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ machineryTypes: ["svc"] }),
        }),
      });
      getServiceByCodeCached.mockResolvedValue({
        code: "svc",
        types: [{ name: "allowed_sub" }],
      });
      const req = {
        params: { id: tid.toString() },
        body: { machinerySubTypes: ["wrong"] },
      };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("machinerySubTypes branch with empty tractor type codes returns 400", async () => {
      Tractor.findOne.mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ machineryTypes: [] }),
        }),
      });
      const req = {
        params: { id: tid.toString() },
        body: { machinerySubTypes: ["any"] },
      };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("machinerySubTypes must be an array when present", async () => {
      Tractor.findOne.mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ machineryTypes: ["svc"] }),
        }),
      });
      const req = {
        params: { id: tid.toString() },
        body: { machinerySubTypes: "not-array" },
      };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("operator may only load own tractor when role is operator", async () => {
      const opFromUser = new mongoose.Types.ObjectId();
      Tractor.findOne.mockImplementationOnce((q) => {
        expect(q.operatorId).toEqual(opFromUser);
        return {
          select: () => ({
            lean: jest.fn().mockResolvedValue({ machineryTypes: ["svc"] }),
          }),
        };
      });
      getServiceByCodeCached.mockResolvedValue({
        code: "svc",
        types: [{ name: "sub" }],
      });
      const req = {
        params: { id: tid.toString() },
        body: { machinerySubTypes: ["sub"] },
        user: { _id: opFromUser, role: "operator" },
      };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateTractorServiceTypes(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe("validateBookingServiceType", () => {
    test("missing serviceType calls next()", async () => {
      const req = { body: {} };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    test("unknown or inactive service returns 400", async () => {
      getServiceByCodeCached.mockResolvedValue(null);
      const req = { body: { serviceType: "nope" } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("inactive service document returns 400", async () => {
      getServiceByCodeCached.mockResolvedValue({
        isActive: false,
        types: [{ name: "t", pricePerHour: 1 }],
        pricePerHour: 1,
      });
      const req = { body: { serviceType: "plough" } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("selected subtype not in service returns 400", async () => {
      getServiceByCodeCached.mockResolvedValue({
        isActive: true,
        types: [{ name: "a", pricePerHour: 1 }],
        pricePerHour: 0,
        pricePerAcre: 0,
      });
      mockPricingLean(null);
      const req = { body: { serviceType: "plough", type: "missing" } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("missing pricing everywhere returns 400", async () => {
      getServiceByCodeCached.mockResolvedValue({
        isActive: true,
        types: [],
        pricePerHour: 0,
        pricePerAcre: 0,
      });
      mockPricingLean({ pricePerHour: 0, pricePerAcre: 0 });
      const req = { body: { serviceType: "plough" } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test("valid service with pricing doc attaches serviceConfig", async () => {
      getServiceByCodeCached.mockResolvedValue({
        isActive: true,
        types: [{ name: "t1", pricePerHour: 10, pricePerAcre: 0 }],
        pricePerHour: 0,
        pricePerAcre: 0,
      });
      mockPricingLean({ pricePerHour: 5, pricePerAcre: 0 });
      const req = { body: { serviceType: "plough", type: "t1" } };
      const res = { status: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await validateBookingServiceType(req, res, next);
      expect(req.serviceConfig).toMatchObject({
        serviceType: "plough",
        selectedType: "t1",
      });
      expect(next).toHaveBeenCalledWith();
    });
  });
});
