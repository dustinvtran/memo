/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { getUserStats } from '../controllers/stats.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/stats/:username
    .with(['GET', 1], () => getUserStats(event))

    .otherwise(() => responses.notFound())
