const mongoose = require("mongoose");
const Complaint = require("../models/complaint.model");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function listComplaints(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    const [total, complaints] = await Promise.all([
      Complaint.countDocuments(filter),
      Complaint.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("bookingId", "status date time")
        .populate("userId", "name phone role")
        .populate("farmerId", "name phone")
        .populate("operatorId", "name phone"),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return sendSuccess(res, 200, "Complaints fetched.", {
      count: total,
      complaints,
      data: complaints,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function respondComplaint(req, res, next) {
  try {
    const { id } = req.params;
    const { adminResponse, status } = req.body || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid complaint id is required.");
    }
    if (!adminResponse || typeof adminResponse !== "string" || !adminResponse.trim()) {
      res.status(400);
      throw new Error("adminResponse is required.");
    }
    if (!["in_progress", "resolved"].includes(status)) {
      res.status(400);
      throw new Error('status must be "in_progress" or "resolved".');
    }
    const complaint = await Complaint.findByIdAndUpdate(
      id,
      { adminResponse: adminResponse.trim(), status },
      { new: true, runValidators: true }
    );
    if (!complaint) {
      res.status(404);
      throw new Error("Complaint not found.");
    }
    logger.info(`[EVENT] Admin respond complaint: ${complaint._id.toString()}`);
    return sendSuccess(res, 200, "Complaint updated.", { complaint });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listComplaints,
  respondComplaint,
};
