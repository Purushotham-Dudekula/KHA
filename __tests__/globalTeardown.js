/**
 * Jest global teardown: release MongoDB Memory Server and Redis handles.
 */
module.exports = async function globalTeardown() {
  const { teardownAllTestResources } = require("./helpers/mongoMemoryHarness");
  await teardownAllTestResources();
};
