/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { searchForWork, retrieveWork } from '../controllers/works.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { getUrlSegments } from '../controllers/utils.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    .with(['GET', 3], () =>
        // GET /api/works/search/:type/:search
        getUrlSegments(event)[0] === 'search'   ? searchForWork(event)

        // GET /api/works/retrieve/:type/:ref
      : getUrlSegments(event)[0] === 'retrieve' ? retrieveWork(event)

      : responses.notFound()
    )

    .otherwise(() => responses.notFound())
