const mongoose = require("mongoose");
const Complaint = require("../models/complaint.model");
const Booking = require("../models/booking.model");
const { sendSuccess } = require("../utils/apiResponse");
const { resolveDocumentInput } = require("../services/storage.service");
const { AppError } = require("../utils/AppError");

async function createComplaint(req, res, next) {
  try {
    const { bookingId, message, category, images } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400);
      throw new Error("message is required.");
    }

    const { COMPLAINT_CATEGORIES } = require("../models/complaint.model");

    if (!category || (typeof category !== "string" && typeof category !== "number")) {
      res.status(400);
      throw new Error("category is required.");
    }

    const requestedCategory = String(category).trim();
    if (!requestedCategory) {
      res.status(400);
      throw new Error("category is required.");
    }

    // Canonicalize category (case-insensitive). Also accept "general complaint" → "General".
    const canonicalCategory =
      COMPLAINT_CATEGORIES.find((x) => x.toLowerCase() === requestedCategory.toLowerCase()) ||
      (requestedCategory.toLowerCase() === "general complaint" ? "General" : null);

    if (!canonicalCategory) {
      res.status(400);
      throw new Error(`Invalid category. Allowed: ${COMPLAINT_CATEGORIES.join(", ")}.`);
    }

    let resolvedImages = [];
    if (images !== undefined && images !== null) {
      const list = Array.isArray(images) ? images : [images];
      if (list.length > 5) {
        res.status(400);
        throw new Error("You can upload a maximum of 5 images.");
      }

      for (const img of list) {
        if (img === undefined || img === null) continue;
        if (typeof img === "string") {
          const s = img.trim();
          if (!s) continue;
          resolvedImages.push(s);
          continue;
        }

        // Support direct URL object: { url: "https://..." }
        if (typeof img === "object" && typeof img.url === "string" && img.url.trim()) {
          resolvedImages.push(img.url.trim());
          continue;
        }

        // Support buffer-backed object for S3 upload (e.g., Multer-style { buffer, originalname, mimetype })
        if (typeof img === "object") {
          const url = await resolveDocumentInput(img);
          if (typeof url !== "string" || !url.trim()) {
            res.status(400);
            throw new Error("Invalid image input.");
          }
          resolvedImages.push(url.trim());
          continue;
        }

        res.status(400);
        throw new Error("Invalid image input.");
      }
    }

    let resolvedBookingId = null;
    let farmerId = null;
    let operatorId = null;

    const hasBookingId =
      bookingId !== undefined && bookingId !== null && String(bookingId).trim() !== "";

    if (hasBookingId) {
      if (!mongoose.Types.ObjectId.isValid(String(bookingId).trim())) {
        res.status(400);
        throw new Error("Valid bookingId is required when provided.");
      }

      const booking = await Booking.findById(bookingId).select("farmer operator");
      if (!booking) {
        res.status(404);
        throw new Error("Booking not found.");
      }

      if (!booking.farmer.equals(req.user._id) && !booking.operator.equals(req.user._id)) {
        res.status(403);
        throw new Error("You can only raise complaints for your own bookings.");
      }

      if (booking.operator.toString() === req.user._id.toString()) {
        res.status(403);
        throw new Error("Operators cannot file a complaint against their own booking");
      }

      if (booking.operator.equals(req.user._id) && canonicalCategory === "Operator Issue") {
        res.status(403);
        throw new Error("You cannot file an Operator Issue complaint about your own assignment.");
      }

      resolvedBookingId = booking._id;
      farmerId = booking.farmer;
      operatorId = booking.operator;
    } else {
      // No bookingId provided: only allowed for general complaints.
      if (canonicalCategory !== "General") {
        res.status(400);
        throw new Error("bookingId is required for this complaint category.");
      }
    }

    const complaint = await Complaint.create({
      bookingId: resolvedBookingId,
      farmerId,
      operatorId,
      userId: req.user._id,
      message: message.trim(),
      status: "open",
      category: canonicalCategory,
      images: resolvedImages,
    });

    return sendSuccess(res, 201, "Complaint submitted.", {
      complaint,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyComplaints(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
    const skip = (page - 1) * limit;

    const complaints = await Complaint.find({
      $or: [{ farmerId: req.user._id }, { operatorId: req.user._id }, { userId: req.user._id }],
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("bookingId", "status date time")
      .populate("farmerId", "name phone")
      .populate("operatorId", "name phone")
      .lean();
    return sendSuccess(res, 200, "Complaints fetched.", {
      count: complaints.length,
      complaints,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { createComplaint, listMyComplaints };
