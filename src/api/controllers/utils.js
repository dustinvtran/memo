/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../errors').Error} Error */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
const { Result, ResultAsync, err, ok } = require('neverthrow')
const errors = require('../utils/errors')
const db = require('../utils/db')
const workTypes = require('../utils/work_types')
const { validateExists } = require('../utils/general')
const { identity } = require('ramda')
const { jwtVerify } = require("jose")
const { tokenSecret, VERIFY_OPTIONS } = require('../utils/session_token')

/**
 * The `sub` of the bearer token, or an unauthorized error.
 *
 * `ResultAsync` rather than `Result` because verification is a promise from
 * jose v4 onward. That is the whole reason this returns what it returns, and
 * why every caller reaches it through `combine` on a list of `ResultAsync`.
 *
 * It also fixes something the synchronous version got wrong. `Result.map`
 * does not catch, so a token that failed to verify did not become an `Err` —
 * it threw out of here, out of the controller, and out of the async handler,
 * and Netlify answered 502. Only a *missing* Authorization header ever
 * produced the 401. An expired session is the common case of that: every
 * authenticated request answered 502 until the user worked out they had to
 * log in again. `ResultAsync.fromPromise` catches the rejection, so a bad
 * token, a tampered one and an expired one are all 401 now. See #139 for the
 * same shape of bug one layer down.
 *
 * A missing `TOKEN_SECRET` deliberately does not land here. `tokenSecret`
 * throws on one, out of this function and out of the handler, because a
 * server with no signing key is a fault of ours and a 401 would tell the user
 * to go and log in again over something logging in cannot fix.
 *
 * @type {(event: Event) => ResultAsync<string, Error>}
 */
const getUserId = (event) =>
  validateExists(event.headers?.authorization)
    .map((authString) => authString.replace('Bearer ', ''))
    .asyncAndThen((jwt) =>
      ResultAsync.fromPromise(jwtVerify(jwt, tokenSecret(), VERIFY_OPTIONS), identity)
    )
    .map(({ payload }) => payload.sub)
    .mapErr(errors.unauthorized)

/** @type {(segmentIndex: number, event: Event) => string} */
const getSegment = (segmentIndex, event) =>
  getUrlSegments(event)[segmentIndex]

/** @type {(event: Event) => string[]} */
const getUrlSegments = (event) =>
  event.path
    .replace(/\.netlify\/functions\/[^/]+/, '')
    .replace(/api\/[^/]+/, '')
    .split('/')
    .filter((s) => s)

/** @type {(event: Event) => Result<any, Error>} */
const getReqBody = Result.fromThrowable(
  (event) => JSON.parse(event.body),
  (err) => errors.req(err, 'the request body is not valid JSON'),
)

/** @type {(name: string) => ResultAsync<string, Error>} */
const findIdOfName = (name) =>
  db.findOneByField_('users', 'username', name)
    .map((user) => user?.userId)

/**
 * The `:type` URL segment every entry-scoped route starts with. A segment
 * naming no type is a 404 here rather than an `undefined` collection that
 * fails somewhere in the driver.
 * @type {(segment: string) => Result<ValidCollection, Error>}
 */
const toEntryCollection = (segment) => {
  const workType = workTypes.byType(segment)
  return workType ? ok(workType.entries) : err(errors.notFound())
}

/**
 * The inverse of toEntryCollection, for the code that has a collection in
 * hand rather than a URL.
 * @type {(entryCollection: ValidCollection) => string | undefined}
 */
const toEntryType = (entryCollection) =>
  workTypes.byEntryCollection(entryCollection)?.type

/**
 * An entry's review lives in the collection of the same name, with
 * `Entries` swapped for `Reviews`.
 * @type {(entryCollection: ValidCollection) => ValidCollection}
 */
const toReviewCollection = (entryCollection) =>
  /** @type any */ (workTypes.byEntryCollection(entryCollection)?.reviews)

module.exports = {
  getUserId,
  getSegment,
  getUrlSegments,
  getReqBody,
  findIdOfName,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
}

