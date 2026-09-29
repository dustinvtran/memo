/**
 * @file Personal API tokens: what one looks like, how one is made, and the
 * only form of it the database ever sees.
 *
 * The session token in `nf_jwt` is the right credential for a browser and the
 * wrong one for anything else. It lasts a fortnight, renews itself only when
 * the page is open, and can be taken back only by rotating `TOKEN_SECRET`,
 * which signs everybody out at once. A script or an agent acting for a user
 * wants something that does not need a page open to stay alive, and that its
 * owner can take back on its own.
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
 * A token lasts until it is revoked unless its owner gives it an end when
 * making it, which is the policy the Anthropic and OpenAI consoles have for
 * their own keys. #464 first capped every token at the 90-day session limit
 * instead, and that was the wrong place to defend: what makes a key that
 * never expires risky is how easily someone else can mint one or use one
 * unnoticed, so those are what get defended — `lastUsedAt` for the second,
 * and for the first, a session cookie script cannot read (#501).
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

/**
 * The longest lifetime a token may be *given*. Not a policy — a token that is
 * given none never expires — only a bound that keeps `createdAt` plus the
 * lifetime an exact number of milliseconds.
 */
const MAX_API_TOKEN_LIFETIME_SECONDS = 100 * 365 * 24 * 3600

/**
 * How stale a stored `lastUsedAt` may be before a request writes it again.
 * The field is there so that an owner can tell a token they are using from
 * one they are not — or one somebody else is — and an hour answers that
 * without a database write on every request a script makes.
 */
const LAST_USED_RESOLUTION_MS = 3600 * 1000

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

/**
 * When a stored token stops working, in milliseconds like its `createdAt`, or
 * `null` for never.
 *
 * A token minted before `expiresAt` was written — #458's, of which production
 * holds one — has no field at all, and is read as never, which is what it was
 * minted as.
 * @type {(stored: { expiresAt?: number | null }) => number | null}
 */
const expiresAtOf = ({ expiresAt }) => expiresAt ?? null

/** @type {(stored: { expiresAt?: number | null }, nowMs: number) => boolean} */
const isExpired = (stored, nowMs) => {
  const expiresAt = expiresAtOf(stored)
  return expiresAt !== null && nowMs >= expiresAt
}

/**
 * Whether this use of a token is worth writing down, which is when it has
 * never been used or not within `LAST_USED_RESOLUTION_MS`.
 * @type {(stored: { lastUsedAt?: number }, nowMs: number) => boolean}
 */
const shouldRecordUse = ({ lastUsedAt }, nowMs) =>
  lastUsedAt === undefined || nowMs - lastUsedAt >= LAST_USED_RESOLUTION_MS

export {
  API_TOKEN_PREFIX,
  MAX_API_TOKEN_NAME_LENGTH,
  MAX_API_TOKEN_LIFETIME_SECONDS,
  LAST_USED_RESOLUTION_MS,
  generateApiToken,
  expiresAtOf,
  isExpired,
  shouldRecordUse,
  isApiToken,
  looksLikeApiToken,
  hashApiToken,
}
