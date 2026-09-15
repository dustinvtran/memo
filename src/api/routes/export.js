/** @file export */
/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { exportUserLists, preflight } from '../controllers/export.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/export/:username
    .with(['GET', 1], () => exportUserLists(event))

    // GET /api/export/:type/:username
    .with(['GET', 2], () => exportUserLists(event))

    // The CORS preflight. This route is the only one that sets
    // `access-control-allow-origin: *`, on purpose — reading it from a page or
    // a notebook is not meant to need a proxy — and without these two lines it
    // answered the preflight `404`, so the browser never sent the `GET` the
    // header was there to permit. A fetch carrying any header outside the
    // handful CORS calls simple is preflighted, which is most of the ways a
    // script asks for JSON. #334.
    .with(['OPTIONS', 1], () => preflight())
    .with(['OPTIONS', 2], () => preflight())

    .otherwise(() => responses.notFound())
