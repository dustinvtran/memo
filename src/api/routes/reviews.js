/** @file entries */
/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { getReview } from '../controllers/reviews.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/reviews/:type/:entryId
    .with(['GET', 2], () => getReview(event))

    .otherwise(() => responses.notFound())
