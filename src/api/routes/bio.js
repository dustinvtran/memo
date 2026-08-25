/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { setBio } from '../controllers/bio.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // POST /api/bio
    .with(['POST', 0], () => setBio(event))

    .otherwise(() => responses.notFound())
