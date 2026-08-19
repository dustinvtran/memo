/**
 * @file The rules the `nf_jwt` session token is judged by: the key it is
 * signed and verified with, the terms it is verified on, and the bound on how
 * long one session may go on sliding.
 *
 * `controllers/auth.js` mints and renews the token, `controllers/utils.js`
 * reads the one on an incoming request, and the first two of those had a copy
 * each. A token is only as good as the weakest place it is checked, so they
 * are checked in one place now.
 *
 * Nothing is required here on purpose: the suite runs with no install, and
 * these are the parts of the token worth testing without one.
 */

/**
 * How long a session may go on renewing itself before Auth0 has to see the
 * user again.
 *
 * The renewal path is the only place this is enforced, so the token in hand
 * when a session reaches the cap goes on working until its own `exp` — the
 * true bound is this plus at most one renewal interval. Clamping that last
 * token's `exp` down to the cap would leave it permanently past the halfway
 * mark at which the frontend renews, which is a renewal request per request
 * for the tail of every session; the untidy bound is much the cheaper of the
 * two.
 *
 * Ninety days rather than thirty because #81 was people being signed out too
 * often and this is a site with a handful of users. The point of the number
 * is that there is one at all — it is a one-line argument to have.
 */
const MAX_SESSION_SECONDS = 90 * 24 * 3600

/* Naming the algorithm on the way in is what stops a caller choosing it for
   us by sending a token whose header says something else. */
const VERIFY_OPTIONS = { algorithms: ['HS256'] }

/**
 * The bytes HS256 signs and verifies with.
 *
 * An unset `TOKEN_SECRET` used to pass through here without a word.
 * `TextEncoder.prototype.encode` defaults its argument to `''` when it is
 * `undefined`, so what came back was not a weak key but a **zero-length**
 * one, and HS256 over an empty key signs and verifies perfectly
 * consistently: nothing looks wrong from the outside while anyone who guesses
 * that is the situation can mint a token for any `sub` they like.
 *
 * Still read at call time rather than at import time, so a function that
 * never touches a token does not care whether the variable is set. That was
 * always an argument for checking here rather than for not checking at all.
 *
 * @type {() => Uint8Array}
 */
const tokenSecret = () => {
  const secret = new TextEncoder().encode(process.env.TOKEN_SECRET)
  if (secret.length === 0) {
    throw new Error('TOKEN_SECRET is not set')
  }
  return secret
}

/**
 * When the session behind a token began, in seconds.
 *
 * `session_started_at` is written at login and carried forward untouched by
 * every renewal, which is the whole of the mechanism: `iat` says when this
 * token was minted, and on a token that has been renewed for a year that is
 * a few days ago.
 *
 * Falling back to `iat` is the lenient reading of a token minted before the
 * claim existed. It grants such a session one more full cap from wherever it
 * happens to be rather than cutting it short; treating the absence as an
 * expired session instead would log every signed-in user out on deploy, for
 * a bound that was not being enforced when their session started. The
 * fallback stops being reachable a fortnight after that deploy — every token
 * minted since carries the claim, and the ones that do not have expired on
 * their own by then.
 *
 * @type {(claims: any) => number | undefined}
 */
const sessionStartedAt = (claims) =>
  claims?.session_started_at ?? claims?.iat

/**
 * Whether the session behind these claims may be renewed again.
 *
 * Claims saying nothing at all about when they were issued are not renewed:
 * `signNetlifyJWT` writes both, so a token without either is not one of ours
 * to slide forward.
 *
 * @type {(claims: any, nowSeconds: number) => boolean}
 */
const isWithinAbsoluteLifetime = (claims, nowSeconds) => {
  const startedAt = sessionStartedAt(claims)
  return startedAt !== undefined && nowSeconds - startedAt < MAX_SESSION_SECONDS
}

module.exports = {
  MAX_SESSION_SECONDS,
  VERIFY_OPTIONS,
  tokenSecret,
  sessionStartedAt,
  isWithinAbsoluteLifetime,
}
