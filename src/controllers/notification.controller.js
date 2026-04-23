const { parsePagination } = require("../utils/pagination");
const Notification = require("../models/notification.model");
const mongoose = require("mongoose");
const { sendSuccess } = require("../utils/apiResponse");

async function listNotifications(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50 });
    const filter = { userId: req.user._id };
    if (req.query.isRead === "true") filter.isRead = true;
    if (req.query.isRead === "false") filter.isRead = false;
    const total = await Notification.countDocuments(filter);
    const totalPages = Math.ceil(total / limit) || 1;

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return sendSuccess(res, 200, "Notifications fetched.", {
      count: notifications.length,
      notifications,
      data: notifications,
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

async function markNotificationRead(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid notification id is required.");
    }
    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: req.user._id },
      { isRead: true },
      { new: true }
    );
    if (!notification) {
      res.status(404);
      throw new Error("Notification not found.");
    }
    return sendSuccess(res, 200, "Notification marked as read.", { notification });
  } catch (error) {
    return next(error);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { $set: { isRead: true } }
    );
    return sendSuccess(res, 200, "All notifications marked as read.", {
      modified: result.modifiedCount,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listNotifications, markNotificationRead, markAllNotificationsRead };
