const Service = require("../models/service.model");
const Pricing = require("../models/pricing.model");
const { logAdminAction } = require("../services/adminAuditLog.service");
const { logAdminActivity } = require("../services/adminActivityLog.service");
const {
  getAllServicesCached,
  invalidateServiceCache,
  refreshServiceCache,
} = require("../services/serviceCache.service");
const { resolveServiceImageInput } = require("../services/serviceImage.service");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");

async function normalizeTypes(rawTypes, serviceImage, context = {}) {
  const list = Array.isArray(rawTypes) ? rawTypes : [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const name = String(t?.name || "").trim().toLowerCase();
    if (!name) continue;
    if (seen.has(name)) {
      throw new Error("Duplicate service type not allowed");
    }
    seen.add(name);
    const image = await resolveServiceImageInput(t?.image, {
      ...context,
      serviceTypeName: name,
      imageScope: "service_type",
    });
    out.push({
      name,
      pricePerHour: t?.pricePerHour !== undefined ? Number(t.pricePerHour) : 0,
      pricePerAcre: t?.pricePerAcre !== undefined ? Number(t.pricePerAcre) : 0,
      image,
      imageEffective: image || serviceImage || "",
    });
  }
  return out;
}

async function seedDefaultServices() {
  const existingCount = await Service.estimatedDocumentCount();
  if (existingCount > 0) {
    logger.info("Services already exist");
    await refreshServiceCache();
    return;
  }

  const defaults = [
    { name: "Ploughing", code: "ploughing", pricePerHour: 1200, pricePerAcre: 1800, isActive: true },
    { name: "Harrow", code: "harrow", pricePerHour: 1100, pricePerAcre: 1600, isActive: true },
    { name: "Rotavator", code: "rotavator", pricePerHour: 1300, pricePerAcre: 2000, isActive: true },
  ];

  await Service.insertMany(defaults, { ordered: false });
  await Promise.all(
    defaults.map((s) =>
      Pricing.updateOne(
        { serviceType: s.code },
        {
          $setOnInsert: {
            serviceType: s.code,
            pricePerHour: Number(s.pricePerHour || 0),
            pricePerAcre: Number(s.pricePerAcre || 0),
          },
        },
        { upsert: true }
      )
    )
  );
  logger.info("Default services seeded");
  await refreshServiceCache();
}

async function listActiveServices(_req, res, next) {
  try {
    const page = Math.max(1, parseInt(_req.query.page, 10) || 1);
    const limitRaw = parseInt(_req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;
    const services = (await getAllServicesCached())
      .filter((s) => s && s.isActive === true)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    // Required frontend shape: [{ name, key }]
    const data = services.slice(skip, skip + limit).map((s) => ({
      name: s.name,
      key: s.code,
      image: s.image || "",
      types: Array.isArray(s.types)
        ? s.types.map((t) => ({
            ...t,
            image: String(t?.image || "").trim(),
            imageEffective: String(t?.image || "").trim() || String(s.image || "").trim(),
          }))
        : [],
    }));

    return sendSuccess(res, 200, "Active services fetched.", data);
  } catch (error) {
    return next(error);
  }
}

async function listAllServices(req, res, next) {
  try {
    const search = typeof req.query?.search === "string" ? req.query.search.trim() : "";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;
    const source = await getAllServicesCached();
    const services = source
      .filter((s) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return String(s.name || "").toLowerCase().includes(q) || String(s.code || "").toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const activeCmp = Number(Boolean(b.isActive)) - Number(Boolean(a.isActive));
        if (activeCmp !== 0) return activeCmp;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    const data = services.slice(skip, skip + limit).map((s) => ({
      id: s._id,
      name: s.name,
      code: s.code,
      pricePerHour: Number(s.pricePerHour || 0),
      pricePerAcre: Number(s.pricePerAcre || 0),
      image: s.image || "",
      types: Array.isArray(s.types)
        ? s.types.map((t) => ({
            ...t,
            image: String(t?.image || "").trim(),
            imageEffective: String(t?.image || "").trim() || String(s.image || "").trim(),
          }))
        : [],
      isActive: Boolean(s.isActive),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return sendSuccess(res, 200, "Services fetched.", { count: services.length, services: data });
  } catch (error) {
    return next(error);
  }
}

async function createService(req, res, next) {
  try {
    const name = String(req.body?.name || "").trim();
    const code = String(req.body?.code || "").trim().toLowerCase();
    const pHour = req.body?.pricePerHour === undefined ? null : Number(req.body.pricePerHour);
    const pAcre = req.body?.pricePerAcre === undefined ? null : Number(req.body.pricePerAcre);
    const image = await resolveServiceImageInput(req.body?.image, {
      serviceCode: code,
      imageScope: "service",
    });
    const types = await normalizeTypes(req.body?.types, image, {
      serviceCode: code,
    });

    const service = await Service.create({
      name,
      code,
      pricePerHour: pHour !== null ? pHour : 0,
      pricePerAcre: pAcre !== null ? pAcre : 0,
      image,
      types,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true,
    });

    await Pricing.updateOne(
      { serviceType: code },
      {
        $set: {
          serviceType: code,
          pricePerHour: Number(service.pricePerHour || 0),
          pricePerAcre: Number(service.pricePerAcre || 0),
        },
      },
      { upsert: true }
    );

    await logAdminAction(req.admin?._id, "CREATE_SERVICE", service._id, {
      code: service.code,
      name: service.name,
      pricePerHour: service.pricePerHour,
      pricePerAcre: service.pricePerAcre,
      isActive: service.isActive,
      typesCount: Array.isArray(service.types) ? service.types.length : 0,
    });
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "SERVICE_CREATED",
      targetId: service._id,
      targetType: "service",
      metadata: { code: service.code, isActive: Boolean(service.isActive), typesCount: Array.isArray(service.types) ? service.types.length : 0 },
    });
    invalidateServiceCache();
    await refreshServiceCache();

    return sendSuccess(res, 201, "Service created.", { service });
  } catch (error) {
    if (error && error.code === 11000) {
      res.status(409);
      return next(new Error("Service code already exists."));
    }
    if (error && error.message === "Duplicate service type not allowed") {
      res.status(400);
      return next(error);
    }
    if (error && error.message === "Invalid image format or size") {
      res.status(400);
      return next(error);
    }
    return next(error);
  }
}

async function updateService(req, res, next) {
  try {
    const { id } = req.params;
    if (req.body?.code !== undefined) {
      res.status(400);
      throw new Error("Service code cannot be modified");
    }
    const updates = {};
    if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body?.pricePerHour !== undefined) updates.pricePerHour = Number(req.body.pricePerHour);
    if (req.body?.pricePerAcre !== undefined) updates.pricePerAcre = Number(req.body.pricePerAcre);
    if (req.body?.isActive !== undefined) updates.isActive = Boolean(req.body.isActive);
    const current = await Service.findById(id).lean();
    if (!current) {
      res.status(404);
      throw new Error("Service not found.");
    }
    const serviceImage =
      req.body?.image !== undefined
        ? await resolveServiceImageInput(req.body?.image, {
            serviceCode: current.code,
            imageScope: "service",
          })
        : String(current.image || "").trim();
    if (req.body?.image !== undefined) updates.image = serviceImage;
    if (req.body?.types !== undefined) {
      updates.types = await normalizeTypes(req.body.types, serviceImage, {
        serviceCode: current.code,
      });
    }

    const service = await Service.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    if (!service) {
      res.status(404);
      throw new Error("Service not found.");
    }

    await Pricing.updateOne(
      { serviceType: service.code },
      {
        $set: {
          serviceType: service.code,
          pricePerHour: Number(service.pricePerHour || 0),
          pricePerAcre: Number(service.pricePerAcre || 0),
        },
      },
      { upsert: true }
    );

    await logAdminAction(req.admin?._id, "UPDATE_SERVICE", service._id, {
      updatedFields: Object.keys(updates),
      code: service.code,
    });
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "SERVICE_UPDATED",
      targetId: service._id,
      targetType: "service",
      metadata: { code: service.code, updatedFields: Object.keys(updates) },
    });
    invalidateServiceCache();
    await refreshServiceCache();

    return sendSuccess(res, 200, "Service updated.", { service });
  } catch (error) {
    if (error && error.code === 11000) {
      res.status(409);
      return next(new Error("Service code already exists."));
    }
    if (error && error.message === "Duplicate service type not allowed") {
      res.status(400);
      return next(error);
    }
    if (error && error.message === "Invalid image format or size") {
      res.status(400);
      return next(error);
    }
    return next(error);
  }
}

async function toggleServiceStatus(req, res, next) {
  try {
    const { id } = req.params;
    const isActive = Boolean(req.body?.isActive);

    const service = await Service.findByIdAndUpdate(id, { $set: { isActive } }, { new: true });
    if (!service) {
      res.status(404);
      throw new Error("Service not found.");
    }

    await logAdminAction(req.admin?._id, "TOGGLE_SERVICE_STATUS", service._id, {
      code: service.code,
      isActive: service.isActive,
    });
    void logAdminActivity({
      adminId: req.admin?._id,
      action: "SERVICE_TOGGLED",
      targetId: service._id,
      targetType: "service",
      metadata: { code: service.code, isActive: Boolean(service.isActive) },
    });
    invalidateServiceCache();
    await refreshServiceCache();

    return sendSuccess(res, 200, "Service status updated.", { service });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listActiveServices,
  listAllServices,
  createService,
  updateService,
  toggleServiceStatus,
  seedDefaultServices,
};

