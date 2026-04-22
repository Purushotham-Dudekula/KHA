const mongoose = require("mongoose");
const Offer = require("../models/offer.model");
const { sendSuccess } = require("../utils/apiResponse");

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function getOffers(req, res, next) {
  try {
    const now = new Date();
    const { skip, limit } = parsePagination(req.query);
    const offers = await Offer.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    })
      .sort({ startDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return sendSuccess(res, 200, "Offers fetched.", { offers });
  } catch (error) {
    return next(error);
  }
}

async function getActiveOffers(req, res, next) {
  try {
    const now = new Date();
    const { skip, limit } = parsePagination(req.query);

    const offers = await Offer.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gt: now },
    })
      // Sort by latest expiry (most recent offers first).
      .sort({ endDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const data = offers.map((o) => ({
      title: o.title,
      discountPercentage: o.discountPercentage,
      // Offer model does not have flatAmount/serviceType today.
      flatAmount: null,
      applicableServiceType: o.serviceType || null,
      // Keep existing fields optional for clients.
      startDate: o.startDate,
      endDate: o.endDate,
      isActive: o.isActive,
    }));

    return sendSuccess(res, 200, "Active offers fetched.", data);
  } catch (error) {
    return next(error);
  }
}

async function createOffer(req, res, next) {
  try {
    const { title, description, discountPercentage, startDate, endDate, isActive } = req.body || {};

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400);
      throw new Error("title is required.");
    }
    if (!description || typeof description !== "string" || !description.trim()) {
      res.status(400);
      throw new Error("description is required.");
    }
    if (discountPercentage === undefined || discountPercentage === null || discountPercentage === "") {
      res.status(400);
      throw new Error("discountPercentage is required.");
    }
    const pct = Number(discountPercentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      res.status(400);
      throw new Error("discountPercentage must be between 0 and 100.");
    }

    const s = startDate ? new Date(startDate) : null;
    const e = endDate ? new Date(endDate) : null;
    if (!s || Number.isNaN(s.getTime())) {
      res.status(400);
      throw new Error("startDate is required and must be a valid date.");
    }
    if (!e || Number.isNaN(e.getTime())) {
      res.status(400);
      throw new Error("endDate is required and must be a valid date.");
    }
    if (e.getTime() <= s.getTime()) {
      res.status(400);
      throw new Error("endDate must be after startDate.");
    }

    const offer = await Offer.create({
      title: title.trim(),
      description: description.trim(),
      discountPercentage: pct,
      isActive: isActive === undefined ? true : Boolean(isActive),
      startDate: s,
      endDate: e,
    });

    return sendSuccess(res, 201, "Offer created.", { offer });
  } catch (error) {
    return next(error);
  }
}

async function updateOffer(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid offer id is required.");
    }

    const { title, description, discountPercentage, startDate, endDate, isActive } = req.body || {};
    const updates = {};
    let nextStartDate;
    let nextEndDate;

    if (title !== undefined) {
      if (!title || typeof title !== "string" || !title.trim()) {
        res.status(400);
        throw new Error("title must be a non-empty string.");
      }
      updates.title = title.trim();
    }
    if (description !== undefined) {
      if (!description || typeof description !== "string" || !description.trim()) {
        res.status(400);
        throw new Error("description must be a non-empty string.");
      }
      updates.description = description.trim();
    }
    if (discountPercentage !== undefined) {
      const pct = Number(discountPercentage);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        res.status(400);
        throw new Error("discountPercentage must be between 0 and 100.");
      }
      updates.discountPercentage = pct;
    }
    if (isActive !== undefined) {
      updates.isActive = Boolean(isActive);
    }
    if (startDate !== undefined) {
      const s = new Date(startDate);
      if (Number.isNaN(s.getTime())) {
        res.status(400);
        throw new Error("startDate must be a valid date.");
      }
      updates.startDate = s;
      nextStartDate = s;
    }
    if (endDate !== undefined) {
      const e = new Date(endDate);
      if (Number.isNaN(e.getTime())) {
        res.status(400);
        throw new Error("endDate must be a valid date.");
      }
      updates.endDate = e;
      nextEndDate = e;
    }

    if (startDate !== undefined || endDate !== undefined) {
      const existing = await Offer.findById(id).select("startDate endDate");
      if (!existing) {
        res.status(404);
        throw new Error("Offer not found.");
      }
      const s = nextStartDate || existing.startDate;
      const e = nextEndDate || existing.endDate;
      if (e.getTime() <= s.getTime()) {
        res.status(400);
        throw new Error("endDate must be after startDate.");
      }
    }

    const offer = await Offer.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    if (!offer) {
      res.status(404);
      throw new Error("Offer not found.");
    }

    return sendSuccess(res, 200, "Offer updated.", { offer });
  } catch (error) {
    return next(error);
  }
}

async function deleteOffer(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid offer id is required.");
    }

    const offer = await Offer.findByIdAndDelete(id);
    if (!offer) {
      res.status(404);
      throw new Error("Offer not found.");
    }

    return sendSuccess(res, 200, "Offer deleted.", { offer });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getOffers, getActiveOffers, createOffer, updateOffer, deleteOffer };

