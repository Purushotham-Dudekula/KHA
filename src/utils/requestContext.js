const { AsyncLocalStorage } = require("async_hooks");
const { randomUUID } = require("crypto");

const storage = new AsyncLocalStorage();

function withRequestContext(req, _res, next) {
  if (!req.requestId) {
    req.requestId = randomUUID();
  }
  const context = {
    requestId: req.requestId || null,
    cancelled: false,
  };
  storage.run(context, () => next());
}

function getRequestContext() {
  return storage.getStore() || null;
}

function isRequestCancelled() {
  const context = getRequestContext();
  return context?.cancelled === true;
}

module.exports = { withRequestContext, getRequestContext, isRequestCancelled };
