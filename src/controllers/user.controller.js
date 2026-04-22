const mongoose = require("mongoose");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Tractor = require("../models/tractor.model");
const Pricing = require("../models/pricing.model");
const Notification = require("../models/notification.model");
const { findNearbyOperators } = require("../services/user.service");
const { getServiceByCodeCached } = require("../services/serviceCache.service");
const { resolveDocumentInput } = require("../services/storage.service");
const { getOperatorReliabilityMetrics } = require("../services/operatorStats.service");
const { getCachedJson, setCachedJson } = require("../services/cache.service");
const { cleanUserResponse } = require("../utils/cleanUserResponse");
const userFacing = require("../constants/userFacing");
const { sendSuccess } = require("../utils/apiResponse");
const { sendSuccess: sendSuccessResponse } = require("../utils/response");
const { logger } = require("../utils/logger");

async function getMe(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select("-otp -otpExpiry");
    if (!user) {
      res.status(404);
      throw new Error("User not found.");
    }
    // Required response shape for this endpoint:
    return sendSuccessResponse(
      res,
      cleanUserResponse(user, { viewerId: req.user._id }),
      "User fetched."
    );
  } catch (error) {
    return next(error);
  }
}

async function selectRole(req, res, next) {
  try {
    const { role } = req.body;

    if (!role) {
      res.status(400);
      throw new Error("Role is required.");
    }

    if (!["farmer", "operator"].includes(role)) {
      res.status(400);
      throw new Error("Role must be either farmer or operator.");
    }

    const roleResets =
      role === "farmer"
        ? {
            tractorType: null,
            experience: null,
            education: "",
            aadhaarNumber: "",
            aadhaarDocument: "",
            drivingLicenseDocument: "",
            verificationStatus: "pending",
            aadhaarVerified: false,
            tractor: null,
          }
        : {
            landArea: 0,
            primaryCrop: "",
            soilType: "",
          };

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { role, ...roleResets },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Role selected successfully.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateFarmerProfile(req, res, next) {
  try {
    const { name, village, mandal, district, state, pincode, landArea, primaryCrop, soilType } = req.body;

    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only users with farmer role can update farmer profile.");
    }

    const disallowedOperatorFields = [
      "tractorType",
      "experience",
      "education",
      "aadhaarNumber",
      "aadhaarDocument",
      "drivingLicenseDocument",
      "verificationStatus",
      "aadhaarVerified",
      "tractor",
    ];
    for (const key of disallowedOperatorFields) {
      if (req.body[key] !== undefined) {
        res.status(400);
        throw new Error(`Field '${key}' is operator-only. Farmers cannot update it.`);
      }
    }

    if (!name || !village || !mandal || !district || !state || !pincode || landArea === undefined) {
      res.status(400);
      throw new Error("name, village, mandal, district, state, pincode, and landArea are required.");
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        name,
        village,
        mandal: mandal || "",
        district: district || "",
        state: state || "",
        pincode: pincode || "",
        landArea,
        primaryCrop: primaryCrop || "",
        soilType: soilType || "",
        isProfileComplete: true,
        // Explicitly clear operator-only fields.
        tractorType: null,
        experience: null,
        education: "",
        aadhaarNumber: "",
        aadhaarDocument: "",
        drivingLicenseDocument: "",
        verificationStatus: "pending",
        aadhaarVerified: false,
        tractor: null,
      },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Farmer profile updated successfully.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateOperatorProfile(req, res, next) {
  try {
    const {
      name,
      village,
      mandal,
      district,
      state,
      pincode,
      experience,
      education,
      aadhaarNumber,
      aadhaarDocument,
    } = req.body;

    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only users with operator role can update operator profile.");
    }

    const disallowedFarmerFields = ["landArea", "primaryCrop", "soilType"];
    for (const key of disallowedFarmerFields) {
      if (req.body[key] !== undefined) {
        res.status(400);
        throw new Error(`Field '${key}' is farmer-only. Operators cannot update it.`);
      }
    }

    if (!name || !village || !mandal || !district || !state || !pincode || !experience || !education || !aadhaarNumber) {
      res.status(400);
      throw new Error(
        "name, village, mandal, district, state, pincode, experience, education and aadhaarNumber are required."
      );
    }

    if (!/^\d{12}$/.test(String(aadhaarNumber).replace(/\s/g, ""))) {
      res.status(400);
      throw new Error("aadhaarNumber must be exactly 12 digits.");
    }

    const update = {
      name,
      village,
      mandal,
      district,
      state,
      pincode,
      experience,
      education,
      aadhaarNumber: String(aadhaarNumber).replace(/\s/g, ""),
      // Ensure farmer-only fields are cleared even if this operator previously was a farmer.
      landArea: 0,
      primaryCrop: "",
      soilType: "",
    };

    if (aadhaarDocument !== undefined) {
      update.aadhaarDocument = String(aadhaarDocument).trim();
    }

    // Prevent role-mixing via explicit KYC status fields.
    if (req.body.verificationStatus !== undefined || req.body.aadhaarVerified !== undefined) {
      res.status(400);
      throw new Error("KYC status fields are admin-managed and cannot be updated by operators here.");
    }

    if (req.body.drivingLicenseDocument !== undefined) {
      res.status(400);
      throw new Error("drivingLicenseDocument must be uploaded via /profile/operator/documents.");
    }

    await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true });

    const user = await User.findById(req.user._id).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Operator profile saved.", {
      nextStep: "add_tractor_and_documents",
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadOperatorDocuments(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can upload operator documents.");
    }

  const aadhaarInput = req.files?.aadhaarDocument?.[0] || req.body.aadhaarDocument;

  const licenseInput =
    req.files?.drivingLicenseDocument?.[0] || req.body.drivingLicenseDocument;

  if (!aadhaarInput || !licenseInput) {
    throw new Error("Aadhaar and Driving License are required");
  }

  const aadhaarResolved = await resolveDocumentInput(aadhaarInput);
  const licenseResolved = await resolveDocumentInput(licenseInput);

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404);
      throw new Error("User not found.");
    }

    user.aadhaarDocument = aadhaarResolved;
    user.drivingLicenseDocument = licenseResolved;
    user.aadhaarVerified = false;
    user.licenseVerified = false;
    if (user.verificationStatus === "rejected") {
      user.verificationStatus = "pending";
    }
    await user.save();

    const fresh = await User.findById(req.user._id).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Operator documents saved. Awaiting admin verification.", {
      user: cleanUserResponse(fresh, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateLocation(req, res, next) {
  try {
    const { latitude, longitude } = req.body;

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400);
      throw new Error("latitude and longitude must be valid numbers.");
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400);
      throw new Error("Invalid latitude/longitude range.");
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        location: {
          type: "Point",
          coordinates: [lng, lat],
        },
      },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Location updated successfully.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    const { isOnline } = req.body;

    if (typeof isOnline !== "boolean") {
      res.status(400);
      throw new Error("isOnline must be true or false.");
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { isOnline },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    return sendSuccess(res, 200, "Status updated successfully.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateLanguage(req, res, next) {
  try {
    const { language } = req.body || {};
    if (!["en", "te", "hi"].includes(language)) {
      res.status(400);
      throw new Error('language must be one of: "en", "te", "hi".');
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { language },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    if (!user) {
      res.status(404);
      throw new Error("User not found.");
    }

    return sendSuccess(res, 200, "Language preference updated.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateFcmToken(req, res, next) {
  try {
    const { fcmToken } = req.body || {};
    if (!fcmToken || typeof fcmToken !== "string" || !fcmToken.trim()) {
      res.status(400);
      throw new Error("fcmToken is required.");
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { fcmToken: fcmToken.trim() },
      { new: true, runValidators: true }
    ).select("-otp -otpExpiry");

    if (!user) {
      res.status(404);
      throw new Error("User not found.");
    }

    return sendSuccess(res, 200, "FCM token updated.", {
      user: cleanUserResponse(user, { viewerId: req.user._id }),
    });
  } catch (error) {
    return next(error);
  }
}

async function getNearbyOperators(req, res, next) {
  try {
    const { lat, lng, radius, serviceType, type } = req.query;

    if (lat === undefined || lng === undefined || radius === undefined) {
      res.status(400);
      throw new Error("lat, lng and radius query params are required.");
    }

    const normalizedServiceType =
      typeof serviceType === "string" && serviceType.trim() ? serviceType.trim().toLowerCase() : null;
    const normalizedType = typeof type === "string" && type.trim() ? type.trim().toLowerCase() : null;

    const { onlineOperators, offlineOperators } = await findNearbyOperators(
      lat,
      lng,
      radius,
      normalizedServiceType
    );

    const shouldFilterByService = Boolean(normalizedServiceType);
    const normalizeCode = (value) => String(value || "").trim().toLowerCase();

    const filterAndDedupeTractors = (rawTractors) => {
      const list = Array.isArray(rawTractors) ? rawTractors : [];
      const out = [];
      const seen = new Set();
      const beforeCount = list.length;
      for (const t of list) {
        if (!t) continue;
        // Safety: keep only approved + available tractors.
        if (t.verificationStatus !== "approved") continue;
        if (t.isAvailable !== true) continue;

        if (shouldFilterByService) {
          const machineryTypes = Array.isArray(t.machineryTypes) ? t.machineryTypes : [];
          const normalizedTypes = machineryTypes.map((s) => normalizeCode(s)).filter(Boolean);
          if (!normalizedTypes.includes(normalizedServiceType)) {
            continue;
          }
          if (normalizedType) {
            const subTypes = Array.isArray(t.machinerySubTypes)
              ? t.machinerySubTypes.map((s) => normalizeCode(s)).filter(Boolean)
              : [];
            if (subTypes.length > 0 && !subTypes.includes(normalizedType)) {
              continue;
            }
          }
          t.machineryTypes = normalizedTypes;
          if (Array.isArray(t.machinerySubTypes)) {
            t.machinerySubTypes = t.machinerySubTypes.map((s) => normalizeCode(s)).filter(Boolean);
          }
        }

        const tid = t.tractorId ?? t._id;
        const key = tid != null ? String(tid) : null;
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
      logger.info("Nearby tractor filtering pass", {
        serviceType: normalizedServiceType,
        before: beforeCount,
        after: out.length,
      });
      return out;
    };

    const mapRow = (operator) => {
      const distance =
        operator.distance != null ? operator.distance : operator.distanceMeters;
      const {
        distance: _d,
        distanceMeters: _dm,
        reliability,
        reliabilityRank,
        acceptanceRate,
        operatorCancellationRate,
        avgResponseHours,
        ...userLike
      } = operator;
      const cleaned = cleanUserResponse(userLike);
      return {
        operatorId: cleaned._id,
        name: cleaned.name || "",
        village: cleaned.village || "",
        distance,
        isOnline: cleaned.isOnline === true,
        averageRating: cleaned.averageRating ?? 0,
        reviewCount: cleaned.reviewCount ?? 0,
        verified: cleaned.verified === true,
        reliability,
        reliabilityRank,
        acceptanceRate,
        cancellationRate: operatorCancellationRate,
        avgResponseTime: avgResponseHours,
        tractors: filterAndDedupeTractors(operator.tractors),
      };
    };

    // Defensive: ensure each operator is processed once and never appears in both lists.
    // Keep list membership based on isOnline.
    const seenOperators = new Set();
    const online = [];
    const offline = [];
    const addOperator = (op) => {
      const row = mapRow(op);
      const opId = row?.operatorId != null ? String(row.operatorId) : null;
      if (!opId) return;
      if (seenOperators.has(opId)) return;
      seenOperators.add(opId);
      if (row.isOnline === true) online.push(row);
      else offline.push(row);
    };
    for (const op of Array.isArray(onlineOperators) ? onlineOperators : []) addOperator(op);
    for (const op of Array.isArray(offlineOperators) ? offlineOperators : []) addOperator(op);

    const preFilterOperatorCount = online.length + offline.length;
    const filteredOnline = online.filter((op) => Array.isArray(op.tractors) && op.tractors.length > 0);
    const filteredOffline = offline.filter((op) => Array.isArray(op.tractors) && op.tractors.length > 0);
    const removedOperators = preFilterOperatorCount - (filteredOnline.length + filteredOffline.length);
    logger.info("Nearby operator filtering pass", {
      serviceType: normalizedServiceType,
      before: preFilterOperatorCount,
      after: filteredOnline.length + filteredOffline.length,
      removedNoTractors: removedOperators,
    });

    const empty = filteredOnline.length === 0 && filteredOffline.length === 0;
    const pricingDoc = normalizedServiceType
      ? await Pricing.findOne({ serviceType: normalizedServiceType })
          .select("serviceType pricePerHour pricePerAcre")
          .lean()
      : null;

    let nearbyDisplayPricing = null;
    if (normalizedServiceType) {
      const svc = await getServiceByCodeCached(normalizedServiceType);
      const servicePriceAcre = Number(svc?.pricePerAcre || pricingDoc?.pricePerAcre || 0);
      const servicePriceHour = Number(svc?.pricePerHour || pricingDoc?.pricePerHour || 0);
      let pricePerAcre = servicePriceAcre;
      let pricePerHour = servicePriceHour;
      if (normalizedType && svc && Array.isArray(svc.types)) {
        const match = svc.types.find((tp) => normalizeCode(tp?.name) === normalizedType);
        if (match) {
          const ta = Number(match.pricePerAcre || 0);
          const th = Number(match.pricePerHour || 0);
          if (ta > 0) pricePerAcre = ta;
          if (th > 0) pricePerHour = th;
        }
      }
      nearbyDisplayPricing = {
        serviceType: pricingDoc?.serviceType || normalizedServiceType,
        type: normalizedType || null,
        pricePerHour,
        pricePerAcre,
        currency: "INR",
      };
    }

    // New: Flatten tractors ("machines") for direct rendering.
    // This is additive and does not modify existing operator lists/shape.
    //
    // Sorting requirement for flattened tractors list ONLY:
    // - distance ASC
    // - isOnline DESC (online first if same distance)
    // - rating DESC (tie-breaker)
    const tractorRows = [];
    const seenFlattenedTractors = new Set();
    const addTractorsFrom = (operatorRow) => {
      const list = Array.isArray(operatorRow?.tractors) ? operatorRow.tractors : [];
      for (const t of list) {
        if (!t) continue;
        // Safety: only include approved + available tractors.
        if (t.verificationStatus !== "approved") continue;
        if (t.isAvailable !== true) continue;

        const tractorId = t.tractorId ?? t._id;
        const tractorKey = tractorId != null ? String(tractorId) : null;
        if (!tractorKey) continue;
        if (seenFlattenedTractors.has(tractorKey)) continue;
        seenFlattenedTractors.add(tractorKey);

        const tractor = {
          tractorId,
          tractorType: t.tractorType,
          brand: t.brand,
          model: t.model,
          machineryTypes: Array.isArray(t.machineryTypes) ? t.machineryTypes : [],
          machinerySubTypes: Array.isArray(t.machinerySubTypes) ? t.machinerySubTypes : [],
          tractorPhoto: t.tractorPhoto || "",
          pricing: nearbyDisplayPricing || {
            serviceType: normalizedServiceType || null,
            type: normalizedType || null,
            pricePerHour: 0,
            pricePerAcre: 0,
            currency: "INR",
          },
          operator: {
            id: operatorRow.operatorId,
            name: operatorRow.name,
            rating: operatorRow.averageRating ?? 0,
            village: operatorRow.village || "",
            isOnline: operatorRow.isOnline === true,
          },
          distance: operatorRow.distance ?? null,
          isAvailable: true,
        };

        tractorRows.push({
          tractor,
          distance: operatorRow.distance ?? null,
          isOnline: operatorRow.isOnline === true,
          rating: operatorRow.averageRating ?? 0,
        });
      }
    };
    for (const o of filteredOnline) addTractorsFrom(o);
    for (const o of filteredOffline) addTractorsFrom(o);

    tractorRows.sort((a, b) => {
      const ad = typeof a.distance === "number" ? a.distance : Number.POSITIVE_INFINITY;
      const bd = typeof b.distance === "number" ? b.distance : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd; // distance ASC

      const ao = a.isOnline ? 1 : 0;
      const bo = b.isOnline ? 1 : 0;
      if (ao !== bo) return bo - ao; // isOnline DESC

      const ar = typeof a.rating === "number" ? a.rating : 0;
      const br = typeof b.rating === "number" ? b.rating : 0;
      if (ar !== br) return br - ar; // rating DESC

      return 0;
    });

    const tractors = tractorRows.map((r) => r.tractor);

    return sendSuccess(res, 200, empty ? userFacing.NO_OPERATORS_NEARBY.message : "Nearby operators fetched.", {
      count: filteredOnline.length + filteredOffline.length,
      onlineOperators: filteredOnline,
      offlineOperators: filteredOffline,
      tractors,
      ...(empty
        ? {
            code: userFacing.NO_OPERATORS_NEARBY.code,
            userTip: userFacing.NO_OPERATORS_NEARBY.userTip,
            retryable: userFacing.NO_OPERATORS_NEARBY.retryable,
          }
        : {}),
    });
  } catch (error) {
    return next(error);
  }
}

async function getOperatorPublicProfile(req, res, next) {
  try {
    const { operatorId } = req.params;
    if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
      res.status(400);
      throw new Error("Valid operatorId is required.");
    }

    const user = await User.findById(operatorId).select("-otp -otpExpiry");
    if (!user || user.role !== "operator") {
      res.status(404);
      throw new Error("Operator not found.");
    }

    const reliability = await getOperatorReliabilityMetrics(operatorId);
    const cleaned = cleanUserResponse(user);

    const tractors = await Tractor.find({
      operatorId,
      verificationStatus: "approved",
      isAvailable: true,
      isDeleted: { $ne: true },
    })
      .select(
        "tractorType brand model registrationNumber machineryTypes machinerySubTypes tractorPhoto verificationStatus isAvailable"
      )
      .lean();

    return sendSuccess(res, 200, "Operator profile fetched.", {
      operator: cleaned,
      tractors,
      reliability,
    });
  } catch (error) {
    return next(error);
  }
}

async function getFarmerDashboard(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can access the dashboard.");
    }

    const cacheKey = `dashboard:farmer:${String(req.user._id)}`;
    const cached = await getCachedJson(cacheKey);
    if (cached) {
      return sendSuccess(res, 200, "Farmer dashboard fetched.", cached);
    }

    const activeStatuses = ["accepted", "confirmed", "en_route", "in_progress"];
    const pendingPaymentStatuses = ["advance_due", "balance_due"];

    const [activeBookingsRes, pendingPaymentsRes, recentBookingsRes, notificationsCountRes] = await Promise.allSettled([
      Booking.find({ farmer: req.user._id, status: { $in: activeStatuses } })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("operator", "name phone village averageRating reviewCount isOnline verificationStatus")
        .populate("tractor", "tractorType brand model registrationNumber tractorPhoto isAvailable")
        .lean(),
      Booking.find({
        farmer: req.user._id,
        paymentStatus: { $in: pendingPaymentStatuses },
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("operator", "name phone village averageRating reviewCount isOnline verificationStatus")
        .populate("tractor", "tractorType brand model registrationNumber tractorPhoto isAvailable")
        .lean(),
      Booking.find({ farmer: req.user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("operator", "name phone village averageRating reviewCount isOnline verificationStatus")
        .populate("tractor", "tractorType brand model registrationNumber tractorPhoto isAvailable")
        .lean(),
      Notification.countDocuments({ userId: req.user._id, isRead: false }),
    ]);

    const activeBookings = activeBookingsRes.status === "fulfilled" ? activeBookingsRes.value : [];
    const pendingPayments = pendingPaymentsRes.status === "fulfilled" ? pendingPaymentsRes.value : [];
    const recentBookings = recentBookingsRes.status === "fulfilled" ? recentBookingsRes.value : [];
    const notificationsCount = notificationsCountRes.status === "fulfilled" ? notificationsCountRes.value : 0;

    // Optional cleanup: keep response consistent with other booking screens.
    const normalizeBooking = (b) => {
      const out = { ...b };
      if (out.operator) out.operator = cleanUserResponse(out.operator);
      return out;
    };

    const payload = {
      activeBookings: activeBookings.map(normalizeBooking),
      pendingPayments: pendingPayments.map(normalizeBooking),
      recentBookings: recentBookings.map(normalizeBooking),
      notificationsCount,
    };
    await setCachedJson(cacheKey, payload, 60);
    return sendSuccess(res, 200, "Farmer dashboard fetched.", payload);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMe,
  selectRole,
  updateFarmerProfile,
  updateOperatorProfile,
  uploadOperatorDocuments,
  updateLocation,
  updateStatus,
  updateLanguage,
  updateFcmToken,
  getFarmerDashboard,
  getNearbyOperators,
  getOperatorPublicProfile,
};
