/**
 * Parses pagination parameters from a request query object.
 * 
 * @param {Object} query - The req.query object.
 * @param {Object} options - Custom default and max limits.
 * @returns {Object} { page, limit, skip }
 */
function parsePagination(query = {}, options = {}) {
  const defaultLimit = options.defaultLimit || 10;
  const maxLimit = options.maxLimit || 50;

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : defaultLimit), maxLimit);
  const skip = (page - 1) * limit;
  
  return { page, limit, skip };
}

module.exports = { parsePagination };
