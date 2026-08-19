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
 *
 * The search term is whatever the user typed, so there is no shape to hold it
 * to — only the decoding to survive.
 * @type {(event: Event) => Promise<Response>}
 */
const searchForWork = (event) => respond(
  getUserId(event)
    .andThen(() => decodeSegment(getUrlSegments(event)[2]))
    .andThen((query) => withAdapter_('search', event, query))
)

/**
 * GET /api/works/retrieve/:type/:ref
 *
 * @type {(event: Event) => Promise<Response>}
 */
const retrieveWork = (event) => {
  const type = getUrlSegments(event)[1]

  // Every prefix that names this work, tried in turn — not every prefix it
  // may carry, since the id in the url belongs to one API. The Google Books
  // adapter caches books under `ISBN__`; `google__` is also accepted because
  // some book documents are stored under that name, and both mean the ISBN.
  const apiNames = workTypes.byType(type)?.identityPrefixes

  return respond(
    // The token is checked before the url is, so that an anonymous caller is
    // told the same thing whatever it asks for — the ref included. This route
    // spends the credentials `search` does — a game costs up to three IGDB
    // round trips — and it also *writes*: a miss here creates the work
    // document. Walking an API's ids anonymously therefore filled `films`,
    // `tvShows`, `games` and `books` with works no entry points at, which is
    // the junk `scripts/audit_database.js` reports and `dedupe_works.js`
    // cleans up.
    getUserId(event)
      .andThen(() => apiNames ? okAsync(apiNames) : errAsync(errors.notFound()))
      .andThen((names) =>
        // Read once, and the one value used for both the lookup and the
        // retrieve. The cache was searched for the raw segment while the
        // adapter was handed the decoded one, so the two could be asking
        // after different works.
        parseRef(type, event).asyncAndThen((apiRefId) =>
          findCachedWork(typeToCollection(type), names.map((name) => `${name}__${apiRefId}`))
            .andThen(({ data, ref }) => data
              ? okAsync(({
                ...data,
                internalRef: ref.id
              }))
              : createWork(event, apiRefId)
            )
        )
      )
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


/** @type {(result: ResultAsync<any, Error>) => Promise<Response>} */
const respond = (result) => toPromise(
  result
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/**
 * The url segment, percent-decoded.
 *
 * `decodeURI` throws on a malformed escape — `decodeURI('%')` is a URIError —
 * and neverthrow does not catch: `Ok.prototype.asyncAndThen` is `f(this.value)`
 * with no try/catch anywhere in it. So the throw left this module
 * synchronously, past every `mapErr(responses.fromError)` above, out of the
 * handler, and Netlify answered `GET /api/works/search/films/%` with an empty
 * 502. The same shape of bug as the `jwtVerify` one `getUserId` in ./utils.js
 * describes, and it has the same fix: catch it where it is thrown. #175.
 * @type {(segment: string) => Result<string, Error>}
 */
const decodeSegment = Result.fromThrowable(
  decodeURI,
  (err) => errors.req(err, 'that url could not be read'),
)

/**
 * The ref a retrieve url names: decoded, and of the shape a ref of this type
 * has. Anything else names no work we hold and none the API could give us, so
 * it is a 404 rather than a query written half by the caller — the games
 * adapter interpolates this into an apicalypse `where`, and the books adapter
 * into a url carrying GOOGLE_API_KEY. See work_types.js. #175.
 * @type {(type: string, event: Event) => Result<string, Error>}
 */
const parseRef = (type, event) =>
  decodeSegment(getUrlSegments(event)[2])
    .andThen((segment) => {
      const ref = workTypes.parseRef(type, segment)
      // The segment goes to the log and not into the body: publishing the
      // caller's own text back to them is how it gets read as ours. #105.
      return ref ? ok(ref) : err(errors.notFound(`not a ${type} ref: ${segment}`))
    })

/**
 * The argument is passed in rather than read from the event here, because the
 * two actions take different things — a search takes whatever was typed, a
 * retrieve takes a ref that has been checked against its type.
 * @type {(action: keyof Adapter, event: Event, argument: string) => ResultAsync<any, any>}
 */
const withAdapter_ = (action, event, argument) =>
  getAdapter(event)
    // TODO: make typechecker happy
    .asyncAndThen((adapter) => adapter[action](argument))

const createWork = (event, apiRefId) =>
  withAdapter_('retrieve', event, apiRefId)
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
