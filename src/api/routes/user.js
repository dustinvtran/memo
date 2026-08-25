/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { getUserFromName } from '../controllers/user.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/user/:username
    .with(['GET', 1], () => getUserFromName(event))

    .otherwise(() => responses.notFound())
