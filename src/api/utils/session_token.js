/**
 * @file The rules the `nf_jwt` session token is judged by: the key it is
 * signed and verified with, the terms it is verified on, how long one lives,
 * and when a signed-out-everywhere session stops counting.
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
 * How long a session token lives, and so how long someone can stay away and
 * come back still signed in. Every request renews it once it is past halfway,
 * so someone who keeps using the site stays signed in for good — the policy
 * Google, Anthropic and most sites have.
 *
 * 400 days because that is the longest Chrome lets any cookie live; asking for
 * more would be quietly cut to it. A fixed cap on the whole session used to
 * stand here (#177, 90 days), because nothing else could end a session: the
 * token was readable from the page and there was no way to revoke one. #501
 * made the token unreadable, and `sessionsValidAfter` — "sign out everywhere"
 * — is the revocation, so the cap has nothing left to do.
 */
const SESSION_LIFETIME_SECONDS = 400 * 24 * 3600

/**
 * The session cookie. `httpOnly`, so script on the page cannot read it and a
 * cross-site scripting bug cannot carry it off — which, since a session can
 * mint API tokens that never expire, would otherwise be a way to a permanent
 * credential (#501). The browser sends it on every same-origin request, and
 * the API reads it there when a request carries no `Authorization` header.
 */
const SESSION_COOKIE_NAME = 'nf_jwt'

/**
 * The half of the session the page *can* read: the session token's `exp`, in
 * seconds, and nothing else. It is how the page knows someone is signed in and
 * when to renew, which it used to learn by reading `nf_jwt` itself. It
 * authenticates nothing — anyone may set it, and a request carrying only it
 * is a request with no session.
 */
const SESSION_HINT_COOKIE_NAME = 'memo_session'

/**
 * The header a write signed in by cookie has to carry.
 *
 * A cookie goes wherever the browser sends it, and a page on another site can
 * make the browser send it — that is cross-site request forgery. `SameSite=Lax`
 * already keeps the cookie off a cross-site `POST`, but that is one browser
 * rule standing alone, and sibling hosts of the site count as same-site under
 * it. A custom header is the second rule: a page on another origin cannot add
 * one to a request without a CORS preflight, and this API answers none. The
 * value is not checked, only its presence — the defence is that it could be
 * sent at all.
 *
 * Reads are exempt because nothing a `GET` answers is readable across origins,
 * and a `GET` writes nothing. A request with an `Authorization` header is
 * exempt because a forged request cannot carry one either.
 */
const CSRF_HEADER = 'x-requested-with'

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
 * every renewal: `iat` says when this token was minted, and on a session that
 * has been renewed for a year that is a few days ago. It is what "sign out
 * everywhere" is measured against, and the reason it survives renewal is that
 * a signed-out session must not be able to renew its way back in.
 *
 * Falling back to `iat` is the reading of a token minted before the claim
 * existed. Every token minted since carries it.
 *
 * @type {(claims: any) => number | undefined}
 */
const sessionStartedAt = (claims) =>
  claims?.session_started_at ?? claims?.iat

/**
 * Whether a session still counts, given the owner's `sessionsValidAfter` — the
 * second they last signed out everywhere, or undefined if they never have.
 *
 * Strictly after: a session that began in the same second as the sign-out is
 * signed out too, since it may be the one that asked. Claims saying nothing
 * about when they were issued never count — `signNetlifyJWT` writes both, so
 * a token without either is not one of ours.
 *
 * @type {(claims: any, sessionsValidAfter: number | undefined) => boolean}
 */
const isSessionCurrent = (claims, sessionsValidAfter) => {
  const startedAt = sessionStartedAt(claims)
  return startedAt !== undefined &&
    (sessionsValidAfter === undefined || startedAt > sessionsValidAfter)
}

export {
  SESSION_COOKIE_NAME,
  SESSION_HINT_COOKIE_NAME,
  CSRF_HEADER,
  SESSION_LIFETIME_SECONDS,
  VERIFY_OPTIONS,
  tokenSecret,
  sessionStartedAt,
  isSessionCurrent,
}