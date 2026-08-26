/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../errors').Error} Error */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
import { Result, ResultAsync, err, ok } from 'neverthrow'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import * as workTypes from '../utils/work_types.js'
import { validateExists } from '../utils/general.js'
import { identity } from 'ramda'
import { jwtVerify } from 'jose'
import { tokenSecret, VERIFY_OPTIONS } from '../utils/session_token.js'
/**
 * The `sub` of the bearer token, or an unauthorized error.
 *
 * `ResultAsync` rather than `Result` because verification is a promise from
 * jose v4 onward. That is the whole reason this returns what it returns, and
 * why every caller reaches it through `ResultAsync.combine` on a list of them.
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

/**
 * The id behind a username, for a caller that has something to say about a
 * name nobody has taken. A miss is `ok(undefined)`, so the caller must look.
 *
 * `export.js` is that caller: it unwraps this and answers its own 404 naming
 * the username. Anything that would only feed the result to a query wants
 * `findIdOfNameOrFail` below instead — an id nothing checked reaches the
 * driver as `null` and matches on a field rather than failing. #253.
 * @type {(name: string) => ResultAsync<string | undefined, Error>}
 */
const findIdOfName = (name) =>
  db.findOneByField_('users', 'username', name)
    .map((user) => user?.userId)

/**
 * The same lookup for a caller that cannot carry on without the id: a name
 * nobody has taken is an err, so the chain stops and the `mapErr` every
 * controller ends with turns it into a 404.
 *
 * `findOneByFieldOrFail_` and not a test on the result of the lenient one, so
 * that a database that did not answer stays a `DBError` — the miss is the only
 * thing that becomes a `NotFound` here.
 * @type {(name: string) => ResultAsync<string, Error>}
 */
const findIdOfNameOrFail = (name) =>
  db.findOneByFieldOrFail_('users', 'username', name)
    .map((user) => user.userId)

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
 * The `entryType` a document of this collection carries — 'Film', the
 * spelling `parsers/works.js` enforces and every work in the database is
 * stored with.
 *
 * Not the `:type` url segment, which is the `type` field of the same row and
 * reads 'films'. This returned that one until #220, under this name, and both
 * callers stored the result in a field they also called `entryType` — so
 * `entryRevisions` documents were written carrying a spelling no work
 * document has ever used. Nothing caught it, because the revisions parser had
 * been written around the value it was being handed.
 * @type {(entryCollection: ValidCollection) => string | undefined}
 */
const toEntryType = (entryCollection) =>
  workTypes.byEntryCollection(entryCollection)?.entryType

/**
 * An entry's review lives in the collection of the same name, with
 * `Entries` swapped for `Reviews`.
 * @type {(entryCollection: ValidCollection) => ValidCollection}
 */
const toReviewCollection = (entryCollection) =>
  /** @type any */ (workTypes.byEntryCollection(entryCollection)?.reviews)

export {
  getUserId,
  getSegment,
  getUrlSegments,
  getReqBody,
  findIdOfName,
  findIdOfNameOrFail,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
}