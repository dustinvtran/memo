/** @file export */
/** @typedef {import('@netlify/functions').Handler} Handler */
const responses = require('../utils/responses')
const { exportUserLists } = require('../controllers/export')
const { matchVerbAndNumberOfUrlSegments } = require('../router')

/** @type Handler */
exports.handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/export/:username
    .with(['GET', 1], () => exportUserLists(event))

    // GET /api/export/:type/:username
    .with(['GET', 2], () => exportUserLists(event))

    .otherwise(() => responses.notFound())
