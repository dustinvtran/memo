/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../errors').Error} Error */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
import { Result, ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import * as workTypes from '../utils/work_types.js'
import { identity } from 'ramda'
import { jwtVerify } from 'jose'
import { parseCookie } from 'cookie'
import { CSRF_HEADER, SESSION_COOKIE_NAME, isSessionCurrent, tokenSecret, VERIFY_OPTIONS } from '../utils/session_token.js'
import { hashApiToken, isExpired, looksLikeApiToken, shouldRecordUse } from '../utils/api_token.js'
import { bearerCredential } from '../utils/bearer.js'
/**
 * The user behind the request's credential, or an unauthorized error.
 *
 * The credential is either a session token — the `nf_jwt` cookie the browser
 * sends, or the same token as a bearer header, whose `sub` is the answer — or
 * a personal API token, told apart by its prefix and looked up by its hash; `utils/api_token.js` says why the two
 * differ. Every route that takes one takes the other, except the ones that
 * manage API tokens, which ask `getSessionUserId` below.
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
  getCredential(event)
    .asyncAndThen((credential) =>
      looksLikeApiToken(credential)
        ? userIdOfApiToken(credential)
        : userIdOfSession(credential)
    )

/**
 * `getUserId` for the routes that manage API tokens, which take a session
 * and nothing else. A token that could mint tokens would outlive its own
 * revocation — whoever held it would make another first — and one that
 * could list them would tell its holder what else to look for.
 * @type {(event: Event) => ResultAsync<string, Error>}
 */
const getSessionUserId = (event) =>
  getCredential(event)
    .asyncAndThen((credential) =>
      looksLikeApiToken(credential)
        ? errAsync(errors.unauthorized(
            undefined,
            'API tokens are managed from a signed-in session, not with an API token'
          ))
        : userIdOfSession(credential)
    )

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

/**
 * The parsed request body, which every route that takes one goes straight on
 * to destructure — so it has to be an object by the time it leaves here.
 *
 * `event.body` is `string | null`, and `JSON.parse(null)` is
 * `JSON.parse('null')` is `null`. So a request sent with no body at all
 * parsed perfectly well, and the `ok(null)` reached `({ newName })`,
 * `({ newBio })` and `{ review, ...rest }` as a value none of them can be
 * destructured from. neverthrow does not catch a synchronous throw, so the
 * `TypeError` went out of the controller, out of the async handler, and
 * Netlify answered an empty 502 — to a request whose only fault was being
 * empty. #259, and the same shape of bug as the `Result.map` that did not
 * catch in `getUserId` above.
 *
 * Checked here rather than at each of the four destructures because all four
 * want the same thing of the body and would all answer the same 400. That is
 * already what `PUT /api/revisions/:type/:ref/draft` answers, by luck rather
 * than by design: its parser runs first and refuses a `null` snapshot.
 *
 * An array, or a bare `5`, is refused for the same reason rather than left to
 * destructure into a set of `undefined` fields and fail a parser further in.
 * Every caller builds an object literal — see `frontend/_includes/js/utils/
 * netlify.js` — so the only requests this turns away are ones no route here
 * could have served.
 * @type {(event: Event) => Result<any, Error>}
 */
const getReqBody = (event) =>
  parseReqBody(event).andThen((body) =>
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? ok(body)
      : err(errors.req(
          `the body parsed as ${describeBody(body)}`,
          'the request body must be a JSON object',
        ))
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

/**
 * How many entries a caller asked for: a positive integer, or `undefined`
 * when it did not ask. Anything else is a 400 that says so.
 *
 * Both routes that take one used to read it with `parseInt`, which is lenient
 * in every direction that matters. `abc` and `0` came out falsy and meant the
 * whole list; `-1` went through to `$limit`, which the driver refuses, so the
 * entries route blamed the database for a typo and the export — which read
 * that refusal as an empty list — answered 200 with nothing in it, and cached
 * it. `12abc` and `1.5` came out as numbers nobody wrote. The test is on the
 * text, not on what `parseInt` makes of it, for that last reason. #463.
 *
 * `null` is absent too: it is what Netlify hands a function whose url has no
 * query string at all.
 * @type {(text: string | null | undefined) => Result<number | undefined, Error>}
 */
const toLimit = (text) => {
  if (text === undefined || text === null) return ok(undefined)

  const limit = Number(text)
  return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(limit)
    ? ok(limit)
    : err(errors.req(undefined, `limit must be a positive integer, not "${text}"`))
}

export {
  getUserId,
  getSessionUserId,
  getSegment,
  getUrlSegments,
  getReqBody,
  findIdOfName,
  findIdOfNameOrFail,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
  toLimit,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(event: Event) => Result<any, Error>} */
const parseReqBody = Result.fromThrowable(
  (event) => JSON.parse(event.body),
  (err) => errors.req(err, 'the request body is not valid JSON'),
)

/**
 * What the body turned out to be, for the log and for nowhere else: its shape
 * and never its contents, since a `detail` here is written out of whatever a
 * stranger sent.
 * @type {(body: any) => string}
 */
const describeBody = (body) =>
  body === null ? 'null'
    : Array.isArray(body) ? 'an array'
    : `a ${typeof body}`
/**
 * The credential a request carries: its `Authorization` header when it has
 * one, which is how a script or an agent sends an API token, and otherwise the
 * session cookie, which is how the browser sends a session now that the page
 * cannot read it to repeat as a header (#501).
 *
 * A write signed in by the cookie alone must also carry `CSRF_HEADER`, for the
 * reason `session_token.js` gives. Its absence is a 401 with a message, rather
 * than the silent one a missing credential gets, because the only callers who
 * see it are hand-written ones that can do something about it.
 * @type {(event: Event) => Result<string, Error>}
 */
const getCredential = (event) => {
  const header = event.headers?.authorization
  if (header) return ok(bearerCredential(header))

  const session = sessionCookieOf(event.headers?.cookie)
  if (!session) return err(errors.unauthorized())

  return SAFE_METHODS.has(event.httpMethod?.toUpperCase()) || event.headers?.[CSRF_HEADER]
    ? ok(session)
    : err(errors.unauthorized(
        undefined,
        `a write signed in by cookie must carry an ${CSRF_HEADER} header`
      ))
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * `parseCookie` rather than a split on `;`, because only the first `=` in a
 * pair separates the name from the value. A header that will not parse is no
 * session rather than a thrown handler.
 * @type {(cookieHeader: string | undefined) => string | undefined}
 */
const sessionCookieOf = (cookieHeader) => {
  if (typeof cookieHeader !== 'string') return undefined
  try {
    return parseCookie(cookieHeader)[SESSION_COOKIE_NAME] || undefined
  } catch (error) {
    return undefined
  }
}

/**
 * The user a session token is for, if the session still counts.
 *
 * A token that verifies may still belong to a session its owner has since
 * signed out everywhere, which is `sessionsValidAfter` on their user
 * document. Checking it costs a lookup per request — by an indexed `userId`,
 * the same lookup most routes make anyway — and it is what lets a session
 * last as long as it is used rather than stopping at a fixed age: there is a
 * way to end one early. An account with no user document yet has never
 * signed out anywhere.
 *
 * A database that did not answer is a 500 rather than a 401, for the reason
 * `userIdOfApiToken` gives.
 * @type {(jwt: string) => ResultAsync<string, Error>}
 */
const userIdOfSession = (jwt) =>
  ResultAsync.fromPromise(jwtVerify(jwt, tokenSecret(), VERIFY_OPTIONS), identity)
    .mapErr(errors.unauthorized)
    .andThen(({ payload }) =>
      db.findOneByField_('users', 'userId', payload.sub)
        .andThen((user) =>
          isSessionCurrent(payload, user?.sessionsValidAfter)
            ? okAsync(payload.sub)
            : errAsync(errors.unauthorized(
                undefined,
                'this session was signed out; log in again'
              ))
        )
    )

/**
 * The owner of an API token, found by its hash. A token nobody holds — never
 * issued, revoked, or mangled on the way — is a 401 like a bad session, and
 * so is one past its `expiresAt`. A database that did not answer stays a
 * `DBError`, and so a 500: a 401 would tell the caller their token is no
 * good, and it may be fine.
 *
 * A miss carries no `detail`, for the reason `findOneByFieldOrFail_` gives: a
 * bad token is the request a stranger makes on purpose, and `fromError` logs
 * every `detail` it is handed. An expired token does say so, since only the
 * holder of a real token can get that far, and "issue another" is the one
 * thing they need to hear.
 * @type {(token: string) => ResultAsync<string, Error>}
 */
const userIdOfApiToken = (token) =>
  db.findOneByField_('apiTokens', 'tokenHash', hashApiToken(token))
    .andThen((stored) => {
      const now = Date.now()
      return !stored?.userId ? errAsync(errors.unauthorized())
        : isExpired(stored, now) ? errAsync(errors.unauthorized(
            undefined,
            'this API token has expired; issue a new one from a signed-in session'
          ))
        : recordUse(stored, now).map(() => stored.userId)
    })

/**
 * Writes `lastUsedAt`, at most once per `LAST_USED_RESOLUTION_MS` a token.
 *
 * Awaited rather than left running, because a function's work stops when it
 * answers and a write started just before may never land. A write that fails
 * does not fail the request: the request was authenticated either way, and
 * answering 500 over a timestamp would make the bookkeeping the thing that
 * broke. It is logged instead, since a `lastUsedAt` that stopped moving is
 * worth knowing about.
 * @type {(stored: any, now: number) => ResultAsync<void, never>}
 */
const recordUse = (stored, now) =>
  shouldRecordUse(stored, now)
    ? db.updateByRef_('apiTokens', stored._id, { lastUsedAt: now })
        .map(() => undefined)
        .orElse((error) => {
          console.warn(`could not record an API token's use: ${error?.error ?? error}`)
          return okAsync(undefined)
        })
    : okAsync(undefined)
