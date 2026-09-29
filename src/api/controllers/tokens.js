/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
/**
 * @file Issuing, listing and revoking personal API tokens.
 *
 * Every route here asks for a session rather than accepting an API token,
 * which is `getSessionUserId`'s whole job; `controllers/utils.js` says why.
 * The token itself leaves the building once, in the answer to the request
 * that made it, and only its hash is stored — so a lost token is revoked and
 * replaced, never recovered.
 *
 * A token expires, at `MAX_API_TOKEN_LIFETIME_SECONDS` or sooner if asked
 * (`expiresInSeconds`), and `utils/api_token.js` says why it may not be
 * longer. An expired token still counts as a token here until it is revoked
 * — it is listed, so its owner can see what stopped working — but not towards
 * the cap, since it can no longer do anything the cap is protecting against.
 */
import { Result, ResultAsync, errAsync, okAsync } from 'neverthrow'
import * as responses from '../utils/responses.js'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import { getSessionUserId, getReqBody, getSegment } from './utils.js'
import { pair, toAsync, toPromise } from '../utils/general.js'
import {
  MAX_API_TOKEN_LIFETIME_SECONDS,
  expiresAtOf,
  generateApiToken,
  hashApiToken,
  isExpired,
} from '../utils/api_token.js'
import {
  apiTokenLifetime as parseApiTokenLifetime,
  apiTokenName as parseApiTokenName,
} from '../utils/parsers/apiTokens.js'

const COLLECTION = 'apiTokens'

/**
 * More than anyone needs, and few enough that a session left open somewhere
 * cannot fill the collection. Revoking one makes room.
 */
const MAX_API_TOKENS_PER_USER = 20

/**
 * What a caller is shown of a stored token: never its hash. The hash cannot
 * be turned back into a token, but nothing a client does needs it either.
 *
 * `expiresAt` is the one the token is judged by, so a token minted before the
 * field existed shows the date it will actually stop, not none. `lastUsedAt`
 * is `null` for a token never used, and otherwise good to within
 * `LAST_USED_RESOLUTION_MS`.
 * @type {(stored: any) => { id: string, name: string, createdAt: number, expiresAt: number, lastUsedAt: number | null }}
 */
const describe = (stored) => ({
  id: stored._id,
  name: stored.name,
  createdAt: stored.createdAt,
  expiresAt: expiresAtOf(stored),
  lastUsedAt: stored.lastUsedAt ?? null,
})

/** @type {(event: Event, context: Context) => Promise<Response>} */
const listApiTokens = (event) => toPromise(
  getSessionUserId(event)
    .andThen((userId) => db.findMany_(COLLECTION, { userId }))
    .map((stored) => stored.map(describe))
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const createApiToken = (event) => toPromise(
  ResultAsync.combine(pair([
    getSessionUserId(event),
    toAsync(getReqBody(event)),
  ]))
    .andThen(([userId, { name, expiresInSeconds }]) =>
      toAsync(Result.combine(pair([
        parseApiTokenName(name),
        parseApiTokenLifetime(expiresInSeconds),
      ])))
        .andThen((valid) => {
          const now = Date.now()
          return db.findMany_(COLLECTION, { userId })
            .andThen((existing) =>
              existing.filter((stored) => !isExpired(stored, now)).length < MAX_API_TOKENS_PER_USER
                ? okAsync(valid)
                : errAsync(errors.conflict(
                    undefined,
                    `there are already ${MAX_API_TOKENS_PER_USER} API tokens; revoke one first`
                  ))
            )
            .andThen(([validName, lifetime = MAX_API_TOKEN_LIFETIME_SECONDS]) => {
              const token = generateApiToken()
              return db.create_(COLLECTION, {
                userId,
                name: validName,
                tokenHash: hashApiToken(token),
                createdAt: now,
                expiresAt: now + lifetime * 1000,
              })
                .map((stored) => ({ ...describe(stored), token }))
            })
        })
    )
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/**
 * Someone else's token is a 404 rather than a 401, so that a guessed id says
 * nothing about whether it exists.
 * @type {(event: Event, context: Context) => Promise<Response>}
 */
const revokeApiToken = (event) => toPromise(
  getSessionUserId(event)
    .andThen((userId) =>
      db.findOneByRef_(COLLECTION, getSegment(0, event))
        .andThen((stored) =>
          stored?.userId === userId
            ? okAsync(stored)
            : errAsync(errors.notFound())
        )
    )
    .andThen((stored) =>
      db.deleteByRef_(COLLECTION, stored._id).map(() => describe(stored))
    )
    .map(responses.ok)
    .mapErr(responses.fromError)
)

export {
  MAX_API_TOKENS_PER_USER,
  listApiTokens,
  createApiToken,
  revokeApiToken,
}
