const mongoose = require("mongoose");
const { getRequestContext } = require("../utils/requestContext");

let initialized = false;

const WRITE_QUERY_OPS = new Set([
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findByIdAndUpdate",
  "findByIdAndDelete",
  "findByIdAndReplace",
]);

function createRequestTimeoutAbortError() {
  const error = new Error("Request processing aborted due to timeout.");
  error.code = "REQUEST_TIMEOUT_ABORTED";
  return error;
}

function throwIfCancelled() {
  const context = getRequestContext();
  if (context?.cancelled === true) {
    throw createRequestTimeoutAbortError();
  }
}

function wrapStaticWriteMethod(methodName) {
  const original = mongoose.Model[methodName];
  if (typeof original !== "function") return;
  mongoose.Model[methodName] = function wrappedStaticWrite(...args) {
    throwIfCancelled();
    return original.apply(this, args);
  };
}

function initDbWriteGuard() {
  if (initialized) return;
  initialized = true;

  const originalExec = mongoose.Query.prototype.exec;
  mongoose.Query.prototype.exec = function wrappedExec(...args) {
    if (WRITE_QUERY_OPS.has(this.op)) {
      throwIfCancelled();
    }
    return originalExec.apply(this, args);
  };

  const originalSave = mongoose.Model.prototype.save;
  mongoose.Model.prototype.save = function wrappedSave(...args) {
    throwIfCancelled();
    return originalSave.apply(this, args);
  };

  const originalDocDeleteOne = mongoose.Model.prototype.deleteOne;
  if (typeof originalDocDeleteOne === "function") {
    mongoose.Model.prototype.deleteOne = function wrappedDocDeleteOne(...args) {
      throwIfCancelled();
      return originalDocDeleteOne.apply(this, args);
    };
  }

  [
    "create",
    "insertMany",
    "bulkWrite",
    "updateOne",
    "updateMany",
    "replaceOne",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "findByIdAndUpdate",
    "findByIdAndDelete",
    "findByIdAndReplace",
    "deleteOne",
    "deleteMany",
  ].forEach(wrapStaticWriteMethod);
}

module.exports = { initDbWriteGuard };
