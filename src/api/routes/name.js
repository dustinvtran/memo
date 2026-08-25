/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { findOwnName, setOwnName, getUserIdFromName } from '../controllers/name.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/name
    .with(['GET', 0], () => findOwnName(event))

    // GET /api/name/:someName
    .with(['GET', 1], () => getUserIdFromName(event))

    // GET /api/name/:newName
    .with(['POST', 0], () => setOwnName(event))

    .otherwise(() => responses.badRequest())
