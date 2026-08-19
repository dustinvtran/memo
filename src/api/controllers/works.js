/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/external_api_adapters/types').Adapter} Adapter */
/** @typedef {import('../utils/errors').Error} Error */
const { toPromise } = require('../utils/general')
const { getUrlSegments, getUserId } = require('./utils')
const { Result, ok, err, ResultAsync, okAsync, errAsync } = require('neverthrow')
const errors = require('../utils/errors')
const responses = require('../utils/responses')
const adapters = require('../utils/external_api_adapters')
const db = require('../utils/db')
const workTypes = require('../utils/work_types')

/**
 * GET /api/works/search/:type/:query
 *
 * Behind a token, alone among the reads on this site along with `retrieve`
 * below — the lists are public and stay public. This one is not a read of our
 * data: the adapter it reaches attaches `TMDB_API_KEY`,
 * `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` or `GOOGLE_API_KEY` server-side,
 * so open it is a free proxy to three metered third-party APIs with nobody to
 * attribute a request to and nothing standing between a caller and IGDB's
 * four-requests-a-second ceiling. Every real caller is a logged-in user
 * filling in the entry form; what scripts and language models are meant to
 * read is `/api/export`, which touches none of this. See #174.
 * @type {(event: Event) => Promise<Response>}
 */
const searchForWork = (event) => toPromise(
  getUserId(event)
    .andThen(() => withAdapter_('search', event))
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/**
 * GET /api/works/retrieve/:type/:ref
 *
 * @type {(event: Event) => Promise<Response>}
 */
const retrieveWork = (event) => {
  const type = getUrlSegments(event)[1]
  const apiRefId = getUrlSegments(event)[2]

  // Every prefix that names this work, tried in turn — not every prefix it
  // may carry, since the id in the url belongs to one API. The Google Books
  // adapter caches books under `ISBN__`; `google__` is also accepted because
  // some book documents are stored under that name, and both mean the ISBN.
  const apiNames = workTypes.byType(type)?.identityPrefixes

  return toPromise(
    // The token is checked before the type segment is, so that an anonymous
    // caller is told the same thing whatever it asks for. This route spends
    // the credentials `search` does — a game costs up to three IGDB round
    // trips — and it also *writes*: a miss here creates the work document.
    // Walking an API's ids anonymously therefore filled `films`, `tvShows`,
    // `games` and `books` with works no entry points at, which is the junk
    // `scripts/audit_database.js` reports and `dedupe_works.js` cleans up.
    getUserId(event)
      .andThen(() => apiNames ? okAsync(apiNames) : errAsync(errors.notFound()))
      .andThen((names) =>
        findCachedWork(typeToCollection(type), names.map((name) => `${name}__${apiRefId}`))
      )
      .andThen(({ data, ref }) => data
        ? okAsync(({
          ...data,
          internalRef: ref.id
        }))
        : createWork(event)
      )
      .map(responses.ok)
      .mapErr(responses.fromError)
  )
}

module.exports = {
  searchForWork,
  retrieveWork,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(type: string) => string | undefined} */
const typeToCollection = (type) => workTypes.byType(type)?.works

/**
 * Tries each apiRef in turn and stops at the first cached work.
 * @type {(collection: any, apiRefs: string[]) => ResultAsync<any, Error>}
 */
const findCachedWork = (collection, apiRefs) =>
  apiRefs.reduce(
    (found, apiRef) => found.andThen((result) =>
      result?.data
        ? okAsync(result)
        : db.findOneByField_(collection, 'apiRefs', apiRef)
    ),
    okAsync({})
  )


/** @type {(action: keyof Adapter, event: Event) => ResultAsync<any, any>} */
const withAdapter_ = (action, event) =>
  getAdapter(event)
    // TODO: make typechecker happy
    .asyncAndThen((adapter) => adapter[action](decodeURI(getUrlSegments(event)[2])))

const createWork = (event) =>
  withAdapter_('retrieve', event)
    .andThen((data) =>
      db.create_(typeToCollection(getUrlSegments(event)[1]), data)
    )
    .map(({ data, ref }) => ({
      ...data,
      internalRef: ref.id,
    }))


/**
 * The adapters are keyed by `:type` segment, so a known type has one.
 * @type {(event: Event) => Result<Adapter, Error>}
 */
const getAdapter = (event) => {
  const type = getUrlSegments(event)[1]
  return workTypes.byType(type) ? ok(adapters[type]) : err(errors.notFound())
}
