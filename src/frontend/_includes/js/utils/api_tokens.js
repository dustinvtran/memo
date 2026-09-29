/**
 * @file What the profile page's API tokens section decides without a browser:
 * which tokens are expired, what order they are listed in, what a new one's
 * name and lifetime may be. The drawing is `components/profile/api_tokens.js`.
 *
 * The rules restate the API's, the way `username_setter.js` restates the
 * username rule, because the bundle has no module system to import them with.
 * `utils/api_token.js` and `utils/parsers/apiTokens.js` under `src/api` are the
 * source of truth, and the server parses whatever arrives whether or not this
 * ran — checking here is so the obvious mistake costs no round trip.
 */

/** `MAX_API_TOKEN_NAME_LENGTH` in `src/api/utils/api_token.js`. */
const MAX_NAME_LENGTH = 64

const DAY_SECONDS = 24 * 3600

/**
 * The lifetimes the mint form offers, in the order it offers them. Never is
 * first because it is the API's default and the policy `utils/api_token.js`
 * argues for; the rest are there for a token its owner already knows is for a
 * short job. `value` is what the `<select>` carries, a string, and
 * `lifetimeOf` is the only thing that reads it back.
 */
const LIFETIMES = [
  { value: 'never', label: 'Never expires', seconds: null },
  { value: '30d', label: '30 days', seconds: 30 * DAY_SECONDS },
  { value: '90d', label: '90 days', seconds: 90 * DAY_SECONDS },
  { value: '1y', label: '1 year', seconds: 365 * DAY_SECONDS },
]

/**
 * The `expiresInSeconds` to send for a `<select>` value, `null` for one that
 * never expires. An unknown value is `null` too rather than a guess: the form
 * only offers the values above, so anything else is a page someone edited,
 * and the API's own default is the least surprising answer to it.
 * @type {(value: string) => number | null}
 */
const lifetimeOf = (value) =>
  LIFETIMES.find((lifetime) => lifetime.value === value)?.seconds ?? null

/**
 * Why a name will be refused, or `undefined` when it will not. Trimmed before
 * it is measured, as the parser does, so a name of spaces is no name.
 * @type {(name: any) => string | undefined}
 */
const whyNotATokenName = (name) => {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'Give the token a name, so you can tell it apart from the others.'
  if (trimmed.length > MAX_NAME_LENGTH) return `A token's name can be at most ${MAX_NAME_LENGTH} characters.`
  return undefined
}

/**
 * Whether a listed token has stopped working. `expiresAt` is `null` for one
 * that never expires, including a token minted before the field existed,
 * which the API answers as `null` rather than leaving out. The comparison is
 * the API's `isExpired`: expired at the instant, not after it.
 * @type {(token: { expiresAt: number | null }, nowMs: number) => boolean}
 */
const isExpired = ({ expiresAt }, nowMs) =>
  expiresAt !== null && expiresAt !== undefined && nowMs >= expiresAt

/**
 * The list in the order it is drawn: tokens that still work first, newest
 * first within each group. The API answers in storage order, which is
 * nothing in particular, and an expired token is kept only so its owner can
 * see what stopped working — below the ones that can still do something.
 * A copy, so the caller's array is left as it came.
 * @type {<T extends { createdAt: number, expiresAt: number | null }>(tokens: T[], nowMs: number) => T[]}
 */
const forDisplay = (tokens, nowMs) =>
  [...tokens].sort((a, b) =>
    Number(isExpired(a, nowMs)) - Number(isExpired(b, nowMs)) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0)
  )

ApiTokens = {
  MAX_NAME_LENGTH,
  LIFETIMES,
  lifetimeOf,
  whyNotATokenName,
  isExpired,
  forDisplay,
}
