// file mostly copypasted from:
// https://github.com/jamesqquick/netlify-auth0-rbac-integration-demo/blob/master/functions/AuthUtils.js
import { SignJWT, jwtVerify } from 'jose'
/* `cookie` 2 is ESM-only and has no default export, so `import cookie from
   'cookie'` is a SyntaxError at load — the #162 failure again, 502ing every
   route rather than this one. Named imports are the only way in.

   It also renamed the whole surface. `serialize` is `stringifySetCookie` and
   `parse` is `parseCookie`, and the two names it did *not* keep are the trap:
   `stringifyCookie` builds a `Cookie` request header out of a whole object and
   silently has nowhere to put `httpOnly`, `secure`, `sameSite` or `maxAge`. It
   is a plausible-looking replacement for `serialize` that answers a string,
   sets a cookie, and drops every attribute this file sets — so every cookie
   below is a `Set-Cookie` and every one of them uses `stringifySetCookie`,
   which takes the name and value as fields of the same object as the rest. */
import { parseCookie, stringifySetCookie } from 'cookie'
import * as errors from '../utils/errors.js'
import * as openidClient from '../utils/openid_client.js'
import * as responses from '../utils/responses.js'
import { VERIFY_OPTIONS, isWithinAbsoluteLifetime, sessionStartedAt, tokenSecret } from '../utils/session_token.js'
/* `openid-client` 6 is ESM-only — its exports map has no `require` condition —
   so it is loaded with `import()`, through the seam in `utils/openid_client`
   rather than from here directly. That works on every loader: the deployed
   runtime is started with `--no-experimental-require-module` (#185 read the
   flag off `process.execArgv`), and `import()` never asks it for the thing it
   refuses. esbuild inlines the package at build time (`netlify.toml`), so the
   deployed function has no module boundary left here; `node --test` runs this
   source unbundled, where `import()` is what keeps it loadable. A top-level
   `require` is what #162 was — a throw while the module is read, before a
   handler runs, 502ing every route at once rather than only this one. The seam
   exists because `import()` does not go through `Module._load`, which is how
   the tests in `auth_token.test.js` stand in for Auth0; that file explains it.

   Version 6 also deleted the class-based API the rest of this file was written
   against. There is no `Issuer` and no `generators`; `new issuer.Client()`,
   `client.authorizationUrl()`, `client.callbackParams()` and
   `client.callback()` are all gone. Each call site below names what replaced
   it. */

const NETLIFY_JWT_EXPIRATION_SECONDS = 14 * 24 * 3600
// cookie's maxAge is in seconds
const LOGIN_COOKIE_MAX_AGE = 30 * 60
const AUTH0_LOGIN_COOKIE_NAME = "auth0_login_cookie"
const NETLIFY_COOKIE_NAME = "nf_jwt"
const isRunningLocally = process.env.NETLIFY_DEV === "true"

/* These two handlers used to `throw` at a request they couldn't read, and an
   uncaught throw out of a Netlify function is a 502. That was wrong twice
   over: the rest of the API answers a structured error through
   `utils/responses` rather than crashing, and a 502 from one route is
   indistinguishable from the failure #162 and #185 are about — an ESM-only
   dependency throwing while the module is read, which 502s *every* route at
   once. `curl -X POST https://nil.moe/api/auth/callback` with no cookie was a
   standing false positive for the one check anyone runs after a dependency
   bump.

   The body is the shape `responses.fromError` gives a `RequestError`, since
   that is what the rest of the API puts on the wire for a 400. It is spelled
   out rather than routed through `fromError` because `fromError`'s other job
   is logging an error's `detail`, and there is no exception here to have one:
   the request simply wasn't a request. Which is also why the caller is told
   the class of failure and not one word more. */
const badRequest = (message) =>
  responses.badRequest({ error: "RequestError", message })

/* The same body, for the requests that get past the guards. Everything Auth0
   checks in a callback — the state, the nonce, the id_token's expiry, the
   response body being the one that was signed — fails on perfectly ordinary
   events: a second login tab overwrites the login cookie the first one is
   still holding, and a back button re-submits a callback that has already been
   spent. So this is the caller's to act on, by starting again, and it is a 400
   for the same reason the guards above are one.

   None of what the library said comes back with it. Its messages name the
   claim that mismatched and the urls it compared, and a failed login is the
   request a stranger makes on purpose. Nor is it logged: a stale tab is not an
   incident, and a line per stale tab is how a log stops being read. */
const loginNotCompleted = () =>
  badRequest("that login could not be completed")

/* The other failure in the same two handlers, and the other side of whose
   fault it is. Discovery is a network round trip to Auth0 taken before
   anything the caller sent is so much as looked at, so when it fails a caller
   who did everything right gets nothing and has nothing to do about it. That
   is ours, and it is a 5xx.

   Through `fromError` rather than spelled out, because unlike the guards there
   *is* an exception here and `detail` is the slot it goes in — logged, never
   sent, which is what #105 put it there for.

   500 rather than the 502 that would describe a bad upstream more precisely: a
   502 out of this route is the one answer the note above is about, and being
   exact about which gateway failed is worth less than staying distinguishable
   from the load-time failure that 502s every route at once. */
const providerUnavailable = (error) =>
  responses.fromError(
    errors.internal(error, "the login provider did not answer")
  )

/* The registered redirect_uri. It moved out of the client metadata in v6 and
   into the authorization request, so it is written down once here rather than
   at the two call sites that used to disagree about it — see `handleCallback`. */
const callbackUrl = () => `${process.env.URL}/.netlify/functions/auth/callback`

/* v5 was `Issuer.discover()` followed by `new issuer.Client({ client_id,
   redirect_uris, response_types })`. In v6 the discovery and the client are
   one `Configuration`: `redirect_uris` is no longer client metadata, and the
   response type is set by calling `useIdTokenResponseType` rather than by
   naming it in the metadata. `implicitAuthentication` refuses to run without
   that call, so the two halves cannot drift apart quietly.

   `None()` is the client authentication method, and it is the honest one here:
   this client has no secret, and a `response_type=id_token` flow never reaches
   the token endpoint to authenticate at. v6 defaults to `client_secret_post`,
   which would be a claim about a secret that does not exist.

   Discovery is a network round trip on every login and every callback, exactly
   as it was in v5. Memoising the `Configuration` would save one per warm
   container, but a rejected promise cached in a container that keeps serving
   is a worse failure than a slow login, so that is its own change. */
const getOpenIDConfiguration = async () => {
  const { discovery, useIdTokenResponseType, None } = await openidClient.load()
  const configuration = await discovery(
    new URL(`https://${process.env.AUTH0_DOMAIN}`),
    process.env.AUTH0_CLIENT_ID,
    undefined,
    None()
  )
  useIdTokenResponseType(configuration)
  return configuration
}

/* Auth0 posts the authorization response as a form body, and v6 reads the
   response parameters off a URL's fragment — and off nothing else on the URL.

   Parsing and re-serialising through `URLSearchParams` normalises the body
   into a fragment that is a well-formed query string by construction. Handing
   the raw body to the fragment setter instead would leave it to that setter's
   own rules, which include silently deleting tabs and newlines: a trailing
   newline on the body is the difference between the state that was signed into
   the login cookie and one byte less of it. The base64 `+` that `state` can
   contain is fine either way — form encoding and fragment parsing agree that
   it means a space, and both sides of this round trip preserve it. */
const asFormPostResponseUrl = (url, body) => {
  const responseUrl = new URL(url)
  responseUrl.hash = new URLSearchParams(body).toString()
  return responseUrl
}

//Refer to Netlify Documentation for token formatting - https://docs.netlify.com/visitor-access/role-based-access-control/#external-providers
const signNetlifyJWT = async ({ aud, sub, roles, startedAt }) => {
  const iat = Math.floor(Date.now() / 1000)
  const exp = Math.floor(iat + NETLIFY_JWT_EXPIRATION_SECONDS)
  const tokenPayload = {
    exp,
    iat,
    updated_at: iat,
    /* A login starts the session here; a renewal passes the original forward
       untouched, which is the only thing that keeps the sliding window from
       sliding for ever. See ../utils/session_token.js. */
    session_started_at: startedAt ?? iat,
    aud,
    sub,
    app_metadata: {
      authorization: { roles },
    },
  }
  /* Netlify insists on `typ`, and the payload carries its own `exp` and
     `iat`, so none of `SignJWT`'s claim setters are wanted here. */
  return await new SignJWT(tokenPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(tokenSecret())
}

//copy over appropriate properties from the original token data
const generateNetlifyJWT = (tokenData) =>
  signNetlifyJWT({
    aud: tokenData.aud,
    sub: tokenData.sub,
    roles: tokenData[`${process.env.AUTH0_TOKEN_NAMESPACE}/roles`],
  })

const generateAuth0LoginCookie = (nonce, encodedStateStr) => {
  const cookieData = { nonce, state: encodedStateStr }
  return stringifySetCookie({
    name: AUTH0_LOGIN_COOKIE_NAME,
    value: JSON.stringify(cookieData),
    secure: !isRunningLocally,
    path: "/",
    maxAge: LOGIN_COOKIE_MAX_AGE,
    httpOnly: true,
    // Auth0 posts the callback back to us cross-site (response_mode: form_post),
    // so the browser only sends this cookie along if it is SameSite=None.
    // That requires Secure, hence the fallback for plain http local dev.
    sameSite: isRunningLocally ? "lax" : "none",
  })
}

/* The random half is passed in rather than generated here, so that this stays
   a pure function of its inputs: v5 reached for `generators.nonce()`, which v6
   does not have, and its replacement is only reachable through an `import()`.
   Nothing reads the field back — `handleCallback` decodes the state for its
   `route` alone — it is entropy, so that a state cannot be guessed. */
const generateEncodedStateString = (route, entropy) => {
  const state = { route: route || "/", nonce: entropy }
  const stateBuffer = Buffer.from(JSON.stringify(state))
  return stateBuffer.toString("base64")
}

/* The route the login is to end on, kept only if it is one of ours (#229).

   It starts life as the `Referer` of the request that began the login, which
   any page on the internet can set by linking here — so what comes back is a
   destination an attacker may have chosen, about to be handed to a browser as
   the last step of a real login on a domain the user trusts. Anything that is
   not this site falls back to the home page, which is where a login with no
   particular destination goes anyway.

   Both sides are resolved and their origins compared, rather than the string
   being tested for a leading slash: `//evil.example/x` passes that test and
   resolves to another origin, which is exactly the case worth closing. What
   comes back is the path rather than the whole url, so the redirect stays
   relative and a later change to `URL` cannot send anyone off-site. A route
   that will not parse — and an unset `URL`, which is a misconfigured site
   rather than a place to send someone — is the home page too. */
const toSafeRoute = (route) => {
  try {
    const site = new URL(process.env.URL)
    const { origin, pathname, search, hash } = new URL(route, site)
    return origin === site.origin ? `${pathname}${search}${hash}` : "/"
  } catch (error) {
    return "/"
  }
}

/* The other end of the two above: everything `handleCallback` needs out of the
   request, or `undefined` when there is no login in progress to finish.

   Absent, expired, not ours and malformed all arrive here as the same thing,
   and all of them mean the same thing — the browser has no half-finished login
   to hand back — so they get one answer rather than four. `JSON.parse` of a
   cookie that isn't the JSON we wrote throws, and so does `JSON.parse` of
   `undefined`, which is what a cookie header without our cookie in it gets
   you.

   The state is decoded here rather than after the response check, so that the
   whole cookie is either good or refused in one place. It is our own base64
   JSON, but the route inside it starts life as a `Referer` header, so it is
   still a stranger's string with a trip through the browser in the middle —
   which is why it is parsed defensively here *and* constrained by
   `toSafeRoute` before anything redirects to it. */
const readLoginCookie = (cookieHeader) => {
  if (typeof cookieHeader !== "string") return undefined
  const value = parseCookie(cookieHeader)[AUTH0_LOGIN_COOKIE_NAME]
  if (typeof value !== "string") return undefined
  try {
    const { nonce, state } = JSON.parse(value)
    if (typeof nonce !== "string" || typeof state !== "string") return undefined
    const { route } = JSON.parse(Buffer.from(state, "base64").toString("utf8"))
    if (typeof route !== "string") return undefined
    return { nonce, state, route: toSafeRoute(route) }
  } catch (error) {
    return undefined
  }
}

/* Both of these clear a cookie, which is `Max-Age=0`. They said `new Date(0)`
   before, and reached the same header only because `serialize` coerces what it
   is handed to a number and the epoch is 0 — `maxAge` is a count of seconds,
   not a date, so any other Date would have been read as its epoch milliseconds
   and set an expiry tens of thousands of years out instead of clearing
   anything. `cookie` 1.x rejected a Date outright and 2.x still does — it
   wants an integer count of seconds and throws at anything else — so the
   coercion was also the thing standing between here and both upgrades. A
   `maxAge` of 0 is not the same as an absent one: it is written out, which is
   what clears the cookie. */
const generateAuth0LoginResetCookie = () => {
  return stringifySetCookie({
    name: AUTH0_LOGIN_COOKIE_NAME,
    value: "",
    secure: !isRunningLocally,
    httpOnly: true,
    path: "/",
    maxAge: 0,
  })
}

const generateLogoutCookie = () => {
  return stringifySetCookie({
    name: NETLIFY_COOKIE_NAME,
    value: "",
    secure: !isRunningLocally,
    path: "/",
    maxAge: 0,
    httpOnly: true,
  })
}

const generateNetlifyCookie = (netlifyToken) =>
  stringifySetCookie({
    name: NETLIFY_COOKIE_NAME,
    value: netlifyToken,
    secure: !isRunningLocally,
    path: "/",
    maxAge: NETLIFY_JWT_EXPIRATION_SECONDS,
    // Unlike the login cookie above, this one is only ever sent to us by our
    // own pages: the API is same-origin and the frontend reads the cookie and
    // repeats it as a bearer header anyway. So the widest thing SameSite has
    // to allow is a top-level navigation back to the site, and Lax allows
    // exactly that. It does not get in the way of the Auth0 callback either —
    // SameSite decides when a cookie is *sent*, and setting one on that
    // cross-site form_post is unaffected; the redirect that follows it is a
    // same-site GET.
    //
    // Chrome already treats an unset SameSite as Lax, so on that browser this
    // changes nothing and is written down instead of assumed. Elsewhere the
    // default is still None, which is where it was worth something.
    //
    // Not `httpOnly`, which is the change this cookie actually wants and
    // cannot have yet: `Http.getToken` reads it from `document.cookie` and
    // `refreshTokenIfNecessary` parses its `exp` there, so hiding it means
    // moving the API to the cookie `getNetlifyJWTFromEvent` already accepts.
    // Its own issue, not this one (#173).
    sameSite: "lax",
  })

const generateNetlifyCookieFromAuth0Token = async (tokenData) =>
  generateNetlifyCookie(await generateNetlifyJWT(tokenData))

const getNetlifyJWTFromEvent = (event) => {
  const authHeader = event.headers?.authorization
  if (authHeader) {
    return authHeader.replace("Bearer ", "")
  }
  const cookieHeader = event.headers?.cookie
  return cookieHeader
    ? parseCookie(cookieHeader)[NETLIFY_COOKIE_NAME]
    : undefined
}

const generateAuth0LogoutUrl = () => {
  const auth0DomainLogout = `https://${process.env.AUTH0_DOMAIN}/v2/logout`
  const urlReturnTo = `returnTo=${encodeURIComponent(process.env.URL)}`
  const urlClientId = `client_id=${process.env.AUTH0_CLIENT_ID}`
  return `${auth0DomainLogout}?${urlReturnTo}&${urlClientId}`
}

const handleLogin = async (event) => {
  if (!event || !event.headers) {
    return badRequest("malformed request")
  }
  const referer = event.headers.referer

  /* Everything past the guard is a conversation with Auth0 and none of it is
     the caller's to get right: discovery is a round trip on every login, and
     the url is built out of the endpoints it answers with. So the whole of it
     gets the one answer, and a rejection leaves here as a response rather than
     as an uncaught throw — which is a 502 with an empty body, and #215 all
     over again. */
  try {
    const { buildAuthorizationUrl, randomNonce, randomState } =
      await openidClient.load()
    const configuration = await getOpenIDConfiguration()

    const nonce = randomNonce()
    const state = generateEncodedStateString(referer, randomState())
    /* v5 was `client.authorizationUrl({...})`, which took the `redirect_uri`
       from the client metadata. v6 builds the url from the configuration and
       the request parameters together, and `redirect_uri` is one of the
       parameters. It answers a `URL` where v5 answered a string.
       https://github.com/panva/openid-client/blob/main/docs/functions/buildAuthorizationUrl.md */
    const authRedirectURL = buildAuthorizationUrl(configuration, {
      redirect_uri: callbackUrl(),
      scope: "openid email profile",
      response_mode: "form_post",
      nonce,
      state,
    })
    return {
      statusCode: 302,
      headers: {
        Location: authRedirectURL.href,
        "Cache-Control": "no-cache",
        "Set-Cookie": generateAuth0LoginCookie(nonce, state),
      },
    }
  } catch (error) {
    return providerUnavailable(error)
  }
}

const handleCallback = async (event) => {
  /* Read before `discovery` is asked anything, so that a request which was
     never going to complete is turned away without a network round trip to
     Auth0 first; it used to be the other way round. No cookie header at all
     lands here too, which is what a bare `curl -X POST` sends. */
  const login = readLoginCookie(event?.headers?.cookie)
  if (!login) {
    return badRequest("no login in progress")
  }
  const { nonce, state } = login

  /* Discovery gets its own `try` rather than sharing the one below, because
     the two failures are not the same person's fault: this one is ours and a
     5xx, the verification is the caller's and a 400. Catching both together
     would tell a user whose login was fine to go and try it again, every time
     Auth0 was unreachable. */
  let implicitAuthentication
  let configuration
  try {
    implicitAuthentication = (await openidClient.load()).implicitAuthentication
    configuration = await getOpenIDConfiguration()
  } catch (error) {
    return providerUnavailable(error)
  }

  /* Built before the `try` below for the same reason `handleRenew` reads
     `tokenSecret()` before its own: a `URL` that will not parse means an unset
     `process.env.URL`, which is a misconfigured site rather than a login
     anyone can retry their way out of. Dressing that up as the caller's
     mistake is the failure mode that comment is about. */
  const responseUrl = asFormPostResponseUrl(callbackUrl(), event.body)

  /* v5 pulled the response out of a request-shaped object with
     `client.callbackParams(req)` and then checked it with `client.callback()`.
     v6 has neither. `implicitAuthentication` is the `response_type=id_token`
     half of what `callback()` used to dispatch between; it takes the response
     parameters itself, and for a `form_post` response mode without a `Request`
     instance the documented way to hand them over is a URL carrying the posted
     body as its fragment.

     Only that fragment is read, which is why v5 got away with passing
     `/.netlify/functions/callback` here while registering
     `/.netlify/functions/auth/callback` as the redirect_uri: the argument was
     the redirect_uri to repeat to the token endpoint, and an id_token response
     never goes there. There is only one of them now, so they cannot disagree.

     The `{ nonce, state }` checks argument split in two — `expectedNonce` is
     positional and required, `expectedState` stayed in the options — and the
     return value is the ID Token claims set itself, rather than a TokenSet to
     call `.claims()` on. */
  let claims
  try {
    claims = await implicitAuthentication(configuration, responseUrl, nonce, {
      expectedState: state,
    })
  } catch (error) {
    return loginNotCompleted()
  }

  const netlifyCookie = await generateNetlifyCookieFromAuth0Token(claims)

  const auth0LoginCookie = generateAuth0LoginResetCookie()

  return {
    statusCode: 302,
    headers: {
      // Where the login started, carried through Auth0 in the state and cut
      // down to a path on this site by `toSafeRoute` on the way back in.
      Location: login.route,
      "Cache-Control": "no-cache",
    },
    multiValueHeaders: {
      "Set-Cookie": [netlifyCookie, auth0LoginCookie],
    },
  }
}

/* Clears the cookie and says so. The frontend keeps using the token it has for
   the request in flight, and the cleared cookie is what stops it asking
   again. */
const sessionOver = () => ({
  statusCode: 401,
  headers: {
    "Cache-Control": "no-store",
    "Set-Cookie": generateLogoutCookie(),
  },
  body: JSON.stringify({ error: "Session expired" }),
})

/* Re-issues the nf_jwt cookie with a fresh expiry so that an active session
   slides forward instead of hard-expiring NETLIFY_JWT_EXPIRATION_SECONDS after
   login. The frontend calls this once the current token is past halfway
   through its lifetime, and MAX_SESSION_SECONDS is how far forward it may go
   in total. */
const handleRenew = async (event) => {
  const currentToken = getNetlifyJWTFromEvent(event)
  if (!currentToken) {
    return {
      statusCode: 401,
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Not logged in" }),
    }
  }

  /* Read before the try, so that an unset TOKEN_SECRET throws out of here
     rather than being caught below and dressed up as an ordinary expired
     session. The server being misconfigured is not the user's fault to fix. */
  const secret = tokenSecret()

  let claims
  try {
    /* A token still inside its renewal window verifies fine, so a failure here
       means the session is genuinely over and the user has to log in again. */
    claims = (await jwtVerify(currentToken, secret, VERIFY_OPTIONS)).payload
  } catch (err) {
    return sessionOver()
  }

  /* The bound the sliding window was missing. Renewal asks nothing of Auth0
     and mints from the presented token's own claims, so without a cap a token
     stolen once was renewable indefinitely and a user disabled in Auth0 kept a
     working session for as long as anything went on renewing it. Reaching the
     cap looks exactly like an expired session from out here, which is both
     true and none of a stranger's business. */
  if (!isWithinAbsoluteLifetime(claims, Math.floor(Date.now() / 1000))) {
    return sessionOver()
  }

  const renewedToken = await signNetlifyJWT({
    aud: claims.aud,
    sub: claims.sub,
    roles: claims.app_metadata?.authorization?.roles,
    startedAt: sessionStartedAt(claims),
  })

  return {
    statusCode: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Set-Cookie": generateNetlifyCookie(renewedToken),
    },
    body: JSON.stringify({ token: renewedToken }),
  }
}

const handleLogout = async () => {
  return {
    statusCode: 302,
    headers: {
      Location: generateAuth0LogoutUrl(),
      "Cache-Control": "no-cache",
      "Set-Cookie": generateLogoutCookie(),
    },
  }
}

export {
  handleLogin,
  handleCallback,
  handleLogout,
  handleRenew,
  /* Exported for their tests. The flow reaches all three through the
     handlers, and they are the pieces of it that can be checked without an
     Auth0 tenant on the other end of the wire — the first two because the v6
     migration rewrote them, the third because it is the whole of what
     `handleCallback` decides before it goes near the network. */
  asFormPostResponseUrl,
  generateEncodedStateString,
  readLoginCookie,
}