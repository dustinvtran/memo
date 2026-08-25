/** @file export */
/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { exportUserLists } from '../controllers/export.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/export/:username
    .with(['GET', 1], () => exportUserLists(event))

    // GET /api/export/:type/:username
    .with(['GET', 2], () => exportUserLists(event))

    .otherwise(() => responses.notFound())
