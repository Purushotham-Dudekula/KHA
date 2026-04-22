const mongoose = require("mongoose");
const Tractor = require("../models/tractor.model");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const {
  validateTractorForApproval,
  deriveTractorVerificationFromDocuments,
} = require("../utils/verification");
const { sendSuccess } = require("../utils/apiResponse");
const { resolveDocumentInput } = require("../services/storage.service");
const { logAdminAction } = require("../services/adminAuditLog.service");

async function getTractorById(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const tractor = await Tractor.findOne({ _id: id, isDeleted: { $ne: true } })
      .populate("operatorId", "name village averageRating reviewCount")
      .lean();

    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    // Ownership validation (IDOR mitigation): only the owning operator can fetch this resource.
    if (String(req.user?.role || "") !== "operator" || String(tractor.operatorId?._id || tractor.operatorId) !== String(req.user._id)) {
      res.status(401);
      throw new Error("Unauthorized");
    }

    const op = tractor.operatorId;
    const operator =
      op && typeof op === "object"
        ? {
            id: op._id,
            name: op.name || "",
            village: op.village || "",
            rating: op.averageRating ?? 0,
            reviewCount: op.reviewCount ?? 0,
          }
        : null;

    return sendSuccess(res, 200, "Tractor fetched.", {
      tractor: {
        ...tractor,
        operator,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createTractor(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can add tractors.");
    }

    const {
      tractorType,
      brand,
      model,
      registrationNumber,
      machineryTypes,
      machinerySubTypes,
      tractorPhoto,
      isAvailable,
    } = req.body;

    if (
      !tractorType ||
      !brand ||
      !model ||
      !registrationNumber ||
      !Array.isArray(machineryTypes) ||
      machineryTypes.length === 0
    ) {
      res.status(400);
      throw new Error(
        "tractorType, brand, model, registrationNumber and machineryTypes (non-empty array) are required."
      );
    }

    const session = await mongoose.startSession();
    let tractor;
    try {
      await session.withTransaction(async () => {
        const [created] = await Tractor.create(
          [
            {
              operatorId: req.user._id,
              tractorType,
              brand: String(brand).trim(),
              model: String(model).trim(),
              registrationNumber: String(registrationNumber).trim(),
              machineryTypes: machineryTypes.map((x) => String(x).trim()).filter(Boolean),
              machinerySubTypes: Array.isArray(machinerySubTypes)
                ? machinerySubTypes.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
                : [],
              tractorPhoto: tractorPhoto != null ? String(tractorPhoto).trim() : "",
              isAvailable: typeof isAvailable === "boolean" ? isAvailable : true,
              verificationStatus: "pending",
            },
          ],
          { session }
        );
        tractor = created;
        await User.updateOne(
          { _id: req.user._id },
          { $set: { isProfileComplete: true } },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    return sendSuccess(res, 201, "Tractor added successfully.", { tractor });
  } catch (error) {
    if (error && error.code === 11000) {
      res.status(400);
      return next(new Error("A tractor with this registration number already exists."));
    }
    return next(error);
  }
}

async function uploadTractorDocuments(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update tractor documents.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const tractor = await Tractor.findOne({ _id: id, operatorId: req.user._id });
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    const updates = {};
    
    const rcInput =
      req.files?.rcDocument?.[0] || req.body.rcDocument;
    if (rcInput) {
      updates.rcDocument = await resolveDocumentInput(rcInput);
      updates.rcVerificationStatus = "pending";
      updates.rcVerificationReason = "";
    }

    const insuranceInput =
      req.files?.insuranceDocument?.[0] || req.body.insuranceDocument;
    if (insuranceInput) {
      updates.insuranceDocument = await resolveDocumentInput(insuranceInput);
      updates.insuranceVerificationStatus = "pending";
      updates.insuranceVerificationReason = "";
    }

    const pollutionInput =
      req.files?.pollutionDocument?.[0] || req.body.pollutionDocument;
    if (pollutionInput) {
      updates.pollutionDocument = await resolveDocumentInput(pollutionInput);
      updates.pollutionVerificationStatus = "pending";
      updates.pollutionVerificationReason = "";
    }

    const fitnessInput =
      req.files?.fitnessDocument?.[0] || req.body.fitnessDocument;
    if (fitnessInput) {
      updates.fitnessDocument = await resolveDocumentInput(fitnessInput);
      updates.fitnessVerificationStatus = "pending";
      updates.fitnessVerificationReason = "";
    }

    const photoInput =
      req.files?.tractorPhoto?.[0] || req.body.tractorPhoto;
    if (photoInput) {
      updates.tractorPhoto = await resolveDocumentInput(photoInput);
    }

    
    const { insuranceExpiry, pollutionExpiry, fitnessExpiry } = req.body;

    if (insuranceExpiry !== undefined) {
      updates.insuranceExpiry = insuranceExpiry
        ? new Date(insuranceExpiry)
        : null;
    }

    if (pollutionExpiry !== undefined) {
      updates.pollutionExpiry = pollutionExpiry
        ? new Date(pollutionExpiry)
        : null;
    }

    if (fitnessExpiry !== undefined) {
      updates.fitnessExpiry = fitnessExpiry
        ? new Date(fitnessExpiry)
        : null;
    }



    if (tractor.verificationStatus === "approved" && Object.keys(updates).length > 0) {
      const merged = { ...tractor.toObject(), ...updates };
      const { ok, missing } = validateTractorForApproval(merged);
      if (!ok) {
        res.status(400);
        throw new Error(
          `Updates would invalidate verification. Missing or invalid: ${missing.join(", ")}.`
        );
      }
    }

    Object.assign(tractor, updates);
    if (Object.keys(updates).length > 0) {
      const derived = deriveTractorVerificationFromDocuments(tractor);
      tractor.verificationStatus = derived.verificationStatus;
      tractor.documentsVerified = derived.documentsVerified;
    }
    await tractor.save();

    return sendSuccess(res, 200, "Tractor documents updated.", { tractor });
  } catch (error) {
    return next(error);
  }
}

async function getMyTractors(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can list their tractors.");
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;
    const filter = { operatorId: req.user._id, isDeleted: { $ne: true } };
    const total = await Tractor.countDocuments(filter);
    const totalPages = Math.ceil(total / limit) || 1;

    const tractors = await Tractor.find(filter)
      .sort({
        createdAt: -1,
      })
      .skip(skip)
      .limit(limit);

    return sendSuccess(res, 200, "Tractors fetched.", {
      count: tractors.length,
      tractors,
      data: tractors,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listAllTractors(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;

    const tractors = await Tractor.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operatorId", "name phone village averageRating reviewCount verificationStatus")
      .lean();

    return sendSuccess(res, 200, "Tractors fetched.", { tractors });
  } catch (error) {
    return next(error);
  }
}

async function setTractorAvailability(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can change tractor availability.");
    }
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }
    if (typeof req.body?.isAvailable !== "boolean") {
      res.status(400);
      throw new Error("isAvailable must be true or false.");
    }
    const tractor = await Tractor.findOneAndUpdate(
      { _id: id, operatorId: req.user._id },
      { isAvailable: req.body.isAvailable },
      { new: true, runValidators: true }
    );
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }
    return sendSuccess(res, 200, "Tractor availability updated.", { tractor });
  } catch (error) {
    return next(error);
  }
}

async function updateTractorBasics(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update tractor details.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const tractor = await Tractor.findOne({ _id: id, operatorId: req.user._id, isDeleted: { $ne: true } });
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    const { brand, model, machineryTypes, machinerySubTypes, availability } = req.body || {};

    const updates = {};
    if (brand !== undefined) updates.brand = String(brand).trim();
    if (model !== undefined) updates.model = String(model).trim();
    if (machineryTypes !== undefined) {
      if (!Array.isArray(machineryTypes)) {
        res.status(400);
        throw new Error("machineryTypes must be an array.");
      }
      updates.machineryTypes = machineryTypes.map((x) => String(x).trim()).filter(Boolean);
    }
    if (machinerySubTypes !== undefined) {
      if (!Array.isArray(machinerySubTypes)) {
        res.status(400);
        throw new Error("machinerySubTypes must be an array.");
      }
      updates.machinerySubTypes = machinerySubTypes.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }
    if (availability !== undefined) updates.isAvailable = Boolean(availability);

    if (Object.keys(updates).length === 0) {
      res.status(400);
      throw new Error("At least one field must be provided.");
    }

    Object.assign(tractor, updates);
    await tractor.save();

    return sendSuccess(res, 200, "Tractor updated.", { tractor });
  } catch (error) {
    return next(error);
  }
}

async function adminSetTractorVerification(req, res, next) {
  try {
    const { tractorId } = req.params;
    const { status } = req.body;

    if (!tractorId || !mongoose.Types.ObjectId.isValid(tractorId)) {
      res.status(400);
      throw new Error("Valid tractorId is required.");
    }

    if (!["approved", "rejected"].includes(status)) {
      res.status(400);
      throw new Error('status must be "approved" or "rejected".');
    }

    const tractor = await Tractor.findById(tractorId);
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    if (status === "approved") {
      const { ok, missing } = validateTractorForApproval(tractor);
      if (!ok) {
        res.status(400);
        throw new Error(
          `Cannot approve: missing or invalid fields — ${missing.join(", ")}. All documents and future expiries are required.`
        );
      }
    }

    tractor.verificationStatus = status;
    tractor.documentsVerified = status === "approved";
    tractor.rcVerificationStatus = status;
    tractor.insuranceVerificationStatus = status;
    tractor.pollutionVerificationStatus = status;
    tractor.fitnessVerificationStatus = status;
    tractor.rcVerificationReason = "";
    tractor.insuranceVerificationReason = "";
    tractor.pollutionVerificationReason = "";
    tractor.fitnessVerificationReason = "";
    const derived = deriveTractorVerificationFromDocuments(tractor);
    tractor.verificationStatus = derived.verificationStatus;
    tractor.documentsVerified = derived.documentsVerified;
    await tractor.save();

    return sendSuccess(res, 200, `Tractor ${status === "approved" ? "approved" : "rejected"}.`, {
      tractor,
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteTractor(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can delete tractors.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const tractor = await Tractor.findOne({ _id: id, operatorId: req.user._id });
    if (!tractor || tractor.isDeleted === true) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    const activeStatuses = ["pending", "accepted", "confirmed", "in_progress", "en_route"];
    const hasActive = await Booking.exists({
      tractor: tractor._id,
      status: { $in: activeStatuses },
    });
    if (hasActive) {
      res.status(400);
      throw new Error("Cannot delete tractor with active bookings");
    }

    tractor.isDeleted = true;
    tractor.isAvailable = false;
    await tractor.save();

    return sendSuccess(res, 200, "Tractor deleted successfully", {});
  } catch (error) {
    return next(error);
  }
}

async function adminCreateTractor(req, res, next) {
  try {
    const {
      operatorId,
      tractorType,
      brand,
      model,
      registrationNumber,
      machineryTypes,
      machinerySubTypes,
      tractorPhoto,
      isAvailable,
      verificationStatus,
    } = req.body || {};

    if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
      res.status(400);
      throw new Error("Valid operatorId is required.");
    }

    const operator = await User.findById(operatorId).select("role");
    if (!operator || operator.role !== "operator") {
      res.status(400);
      throw new Error("operatorId must belong to an operator.");
    }

    const tractor = await Tractor.create({
      operatorId,
      tractorType,
      brand: String(brand).trim(),
      model: String(model).trim(),
      registrationNumber: String(registrationNumber).trim(),
      machineryTypes: Array.isArray(machineryTypes)
        ? machineryTypes.map((x) => String(x).trim()).filter(Boolean)
        : [],
      machinerySubTypes: Array.isArray(machinerySubTypes)
        ? machinerySubTypes.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
        : [],
      tractorPhoto: tractorPhoto != null ? String(tractorPhoto).trim() : "",
      isAvailable: typeof isAvailable === "boolean" ? isAvailable : true,
      verificationStatus: verificationStatus || "pending",
      documentsVerified: verificationStatus === "approved",
    });

    await logAdminAction(req.admin?._id, "CREATE_TRACTOR", tractor._id, {
      operatorId,
      registrationNumber: tractor.registrationNumber,
    });

    return sendSuccess(res, 201, "Tractor created by admin.", { tractor });
  } catch (error) {
    if (error && error.code === 11000) {
      res.status(409);
      return next(new Error("A tractor with this registration number already exists."));
    }
    return next(error);
  }
}

async function adminUpdateTractor(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }

    const updates = { ...req.body };
    if (updates.operatorId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(updates.operatorId)) {
        res.status(400);
        throw new Error("Valid operatorId is required.");
      }
      const operator = await User.findById(updates.operatorId).select("role");
      if (!operator || operator.role !== "operator") {
        res.status(400);
        throw new Error("operatorId must belong to an operator.");
      }
    }
    if (updates.machineryTypes && Array.isArray(updates.machineryTypes)) {
      updates.machineryTypes = updates.machineryTypes.map((x) => String(x).trim()).filter(Boolean);
    }
    if (updates.machinerySubTypes && Array.isArray(updates.machinerySubTypes)) {
      updates.machinerySubTypes = updates.machinerySubTypes.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }
    if (updates.brand !== undefined) updates.brand = String(updates.brand).trim();
    if (updates.model !== undefined) updates.model = String(updates.model).trim();
    if (updates.registrationNumber !== undefined) {
      updates.registrationNumber = String(updates.registrationNumber).trim();
    }
    if (updates.tractorPhoto !== undefined) updates.tractorPhoto = String(updates.tractorPhoto).trim();

    const tractor = await Tractor.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }

    await logAdminAction(req.admin?._id, "UPDATE_TRACTOR", tractor._id, {
      updatedFields: Object.keys(updates),
    });

    return sendSuccess(res, 200, "Tractor updated by admin.", { tractor });
  } catch (error) {
    if (error && error.code === 11000) {
      res.status(409);
      return next(new Error("A tractor with this registration number already exists."));
    }
    return next(error);
  }
}

async function adminDeleteTractor(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid tractor id is required.");
    }
    const tractor = await Tractor.findByIdAndDelete(id);
    if (!tractor) {
      res.status(404);
      throw new Error("Tractor not found.");
    }
    await logAdminAction(req.admin?._id, "DELETE_TRACTOR", tractor._id, {
      registrationNumber: tractor.registrationNumber,
    });
    return sendSuccess(res, 200, "Tractor deleted by admin.", { tractor });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getTractorById,
  createTractor,
  uploadTractorDocuments,
  getMyTractors,
  listAllTractors,
  setTractorAvailability,
  updateTractorBasics,
  adminSetTractorVerification,
  deleteTractor,
  adminCreateTractor,
  adminUpdateTractor,
  adminDeleteTractor,
};
