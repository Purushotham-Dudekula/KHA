const mongoose = require("mongoose");
const Pricing = require("../models/pricing.model");
const Tractor = require("../models/tractor.model");
const { getAllServicesCached, getServiceByCodeCached } = require("../services/serviceCache.service");
const { logger } = require("../utils/logger");

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

async function validateTractorServiceTypes(req, res, next) {
  try {
    const hasMt = req.body && req.body.machineryTypes !== undefined;
    const hasMst = req.body && req.body.machinerySubTypes !== undefined;
    if (!hasMt && !hasMst) {
      return next();
    }

    let codes = [];

    if (hasMt) {
      const raw = req.body.machineryTypes;
      if (!Array.isArray(raw) || raw.length === 0) {
        res.status(400);
        throw new Error("At least one valid service type is required");
      }

      const normalized = [...new Set(raw.map(normalizeCode).filter(Boolean))];
      if (!normalized.length) {
        res.status(400);
        throw new Error("At least one valid service type is required");
      }

      req.body.machineryTypes = normalized;
      codes = normalized;

      const allServices = await getAllServicesCached();
      if (allServices.length > 0) {
        const set = new Set(allServices.map((s) => String(s.code || "").trim().toLowerCase()));
        if (!req.body.machineryTypes.every((code) => set.has(code))) {
          res.status(400);
          throw new Error("At least one valid service type is required");
        }
      }
    } else if (hasMst) {
      const tid = req.params?.id;
      if (!tid || !mongoose.Types.ObjectId.isValid(tid)) {
        res.status(400);
        throw new Error("Valid tractor id is required.");
      }
      const q = { _id: tid, isDeleted: { $ne: true } };
      if (req.user?._id && req.user.role === "operator") {
        q.operatorId = req.user._id;
      }
      const tractor = await Tractor.findOne(q).select("machineryTypes").lean();
      if (!tractor) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      codes = Array.isArray(tractor.machineryTypes)
        ? tractor.machineryTypes.map(normalizeCode).filter(Boolean)
        : [];
      if (!codes.length) {
        res.status(400);
        throw new Error("Invalid service type");
      }
    }

    if (!hasMst) {
      return next();
    }

    const rawSubs = req.body.machinerySubTypes;
    if (!Array.isArray(rawSubs)) {
      res.status(400);
      throw new Error("Invalid service type");
    }

    const subs = [...new Set(rawSubs.map(normalizeCode).filter(Boolean))];
    if (!subs.length) {
      delete req.body.machinerySubTypes;
      return next();
    }

    const allowed = new Set();
    for (const c of codes) {
      const svc = await getServiceByCodeCached(c);
      if (!svc || !Array.isArray(svc.types)) continue;
      for (const t of svc.types) {
        const n = normalizeCode(t?.name);
        if (n) allowed.add(n);
      }
    }

    const allValid = subs.every((s) => allowed.has(s));
    if (!allValid) {
      res.status(400);
      throw new Error("Invalid service type");
    }

    req.body.machinerySubTypes = subs;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function validateBookingServiceType(req, res, next) {
  try {
    const serviceType = normalizeCode(req.body?.serviceType);
    const selectedTypeRaw = req.body?.type ?? req.body?.subtype;
    const selectedType = normalizeCode(selectedTypeRaw);
    if (!serviceType) {
      return next();
    }
    req.body.serviceType = serviceType;
    if (selectedType) {
      req.body.type = selectedType;
      req.body.subtype = selectedType;
    }
    delete req.body.pricePerHour;
    delete req.body.pricePerAcre;
    delete req.body.baseAmount;
    delete req.body.totalAmount;

    const service = await getServiceByCodeCached(serviceType);
    if (!service || service.isActive !== true) {
      res.status(400);
      throw new Error("Invalid or unsupported service type");
    }

    const normalizedTypes = Array.isArray(service.types)
      ? service.types
          .map((t) => ({
            name: normalizeCode(t?.name),
            pricePerHour: Number(t?.pricePerHour || 0),
            pricePerAcre: Number(t?.pricePerAcre || 0),
          }))
          .filter((t) => t.name)
      : [];
    const matchedType = selectedType ? normalizedTypes.find((t) => t.name === selectedType) || null : null;
    if (selectedType && !matchedType) {
      res.status(400);
      throw new Error("Invalid service type");
    }

    const serviceHasPricing =
      Number(service.pricePerHour || 0) > 0 || Number(service.pricePerAcre || 0) > 0;
    const typeHasPricing = matchedType
      ? Number(matchedType.pricePerHour || 0) > 0 || Number(matchedType.pricePerAcre || 0) > 0
      : false;

    const pricing = await Pricing.findOne({ serviceType }).lean();
    const hasPricingDoc = Boolean(pricing);
    const pricingDocHasValues =
      hasPricingDoc &&
      (Number(pricing.pricePerHour || 0) > 0 || Number(pricing.pricePerAcre || 0) > 0);

    // Subtype pricing → service pricing → pricing collection (when values present).
    if (!typeHasPricing && !serviceHasPricing && !pricingDocHasValues) {
      logger.warn("Missing pricing for serviceType", { serviceType });
      res.status(400);
      throw new Error("Pricing not configured for this service");
    }

    req.serviceConfig = {
      serviceType,
      selectedType: matchedType ? matchedType.name : null,
      selectedTypePricing: matchedType
        ? {
            pricePerHour: Number(matchedType.pricePerHour || 0),
            pricePerAcre: Number(matchedType.pricePerAcre || 0),
          }
        : null,
      servicePricing: {
        pricePerHour: Number(service.pricePerHour || 0),
        pricePerAcre: Number(service.pricePerAcre || 0),
      },
      pricingDoc: pricing
        ? {
            pricePerHour: Number(pricing.pricePerHour || 0),
            pricePerAcre: Number(pricing.pricePerAcre || 0),
          }
        : null,
      pricingDocHasValues,
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  validateTractorServiceTypes,
  validateBookingServiceType,
};
