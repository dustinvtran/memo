/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { listApiTokens, createApiToken, revokeApiToken } from '../controllers/tokens.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/tokens
    .with(['GET', 0], () => listApiTokens(event))

    // POST /api/tokens
    .with(['POST', 0], () => createApiToken(event))

    // DELETE /api/tokens/:id
    .with(['DELETE', 1], () => revokeApiToken(event))

    .otherwise(() => responses.notFound())
