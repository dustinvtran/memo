/**
 * @file Personal API tokens: what one looks like, how one is made, and the
 * only form of it the database ever sees.
 *
 * The session token in `nf_jwt` is the right credential for a browser and the
 * wrong one for anything else. It lasts a fortnight, renews itself only when
 * the page is open, and can be taken back only by rotating `TOKEN_SECRET`,
 * which signs everybody out at once. A script or an agent acting for a user
 * wants the opposite on every count: something that lasts until its owner
 * says otherwise, and that its owner can take back on its own.
 *
 * So an API token is not a JWT. It is 32 random bytes behind a fixed prefix,
 * handed to its owner once, and stored as its SHA-256 and nothing else. A
 * plain hash rather than a slow one is deliberate: a slow hash is for secrets
 * a person chose, which are guessable, and 256 bits from `randomBytes` are
 * not. What a slow hash would buy here is a slower request, every request.
 *
 * The prefix is what lets `getUserId` tell the two kinds of bearer apart
 * without trying one and falling back to the other, and it is also what a
 * secret scanner matches on when one is pasted somewhere it should not be.
 *
 * Nothing but `node:crypto` is imported, so the suite exercises all of this
 * with no install.
 */
import { createHash, randomBytes } from 'node:crypto'

const API_TOKEN_PREFIX = 'memo_pat_'

/** 32 bytes is 43 characters of base64url, unpadded. */
const API_TOKEN_PATTERN = /^memo_pat_[A-Za-z0-9_-]{43}$/

/**
 * A name is how its owner tells their tokens apart when revoking one — "the
 * laptop", "claude" — and is never shown to anyone else.
 */
const MAX_API_TOKEN_NAME_LENGTH = 64

/** @type {() => string} */
const generateApiToken = () =>
  API_TOKEN_PREFIX + randomBytes(32).toString('base64url')

/**
 * Whether a bearer credential is shaped like an API token. Shape only: a
 * token that matches still has to be found by its hash.
 * @type {(credential: unknown) => boolean}
 */
const isApiToken = (credential) =>
  typeof credential === 'string' && API_TOKEN_PATTERN.test(credential)

/**
 * Whether a bearer credential was *meant* as an API token, including one
 * that has been truncated or mangled on the way. Those are refused as API
 * tokens rather than handed to the JWT verifier, whose error would be about
 * a JWT the caller never sent.
 * @type {(credential: unknown) => boolean}
 */
const looksLikeApiToken = (credential) =>
  typeof credential === 'string' && credential.startsWith(API_TOKEN_PREFIX)

/** @type {(token: string) => string} */
const hashApiToken = (token) =>
  createHash('sha256').update(token).digest('hex')

export {
  API_TOKEN_PREFIX,
  MAX_API_TOKEN_NAME_LENGTH,
  generateApiToken,
  isApiToken,
  looksLikeApiToken,
  hashApiToken,
}
