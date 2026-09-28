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
 */
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import * as responses from '../utils/responses.js'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import { getSessionUserId, getReqBody, getSegment } from './utils.js'
import { pair, toAsync, toPromise } from '../utils/general.js'
import { generateApiToken, hashApiToken } from '../utils/api_token.js'
import { apiTokenName as parseApiTokenName } from '../utils/parsers/apiTokens.js'

const COLLECTION = 'apiTokens'

/**
 * More than anyone needs, and few enough that a session left open somewhere
 * cannot fill the collection. Revoking one makes room.
 */
const MAX_API_TOKENS_PER_USER = 20

/**
 * What a caller is shown of a stored token: never its hash. The hash cannot
 * be turned back into a token, but nothing a client does needs it either.
 * @type {(stored: any) => { id: string, name: string, createdAt: number }}
 */
const describe = ({ _id, name, createdAt }) => ({ id: _id, name, createdAt })

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
    .andThen(([userId, { name }]) =>
      toAsync(parseApiTokenName(name))
        .andThen((validName) =>
          db.findMany_(COLLECTION, { userId })
            .andThen((existing) =>
              existing.length < MAX_API_TOKENS_PER_USER
                ? okAsync(validName)
                : errAsync(errors.conflict(
                    undefined,
                    `there are already ${MAX_API_TOKENS_PER_USER} API tokens; revoke one first`
                  ))
            )
        )
        .andThen((validName) => {
          const token = generateApiToken()
          return db.create_(COLLECTION, {
            userId,
            name: validName,
            tokenHash: hashApiToken(token),
            createdAt: Date.now(),
          })
            .map((stored) => ({ ...describe(stored), token }))
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
