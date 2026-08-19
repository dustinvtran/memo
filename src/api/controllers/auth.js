// file mostly copypasted from:
// https://github.com/jamesqquick/netlify-auth0-rbac-integration-demo/blob/master/functions/AuthUtils.js
const { Issuer, generators } = require("openid-client")
const { SignJWT, jwtVerify } = require("jose")
const cookie = require("cookie")

const NETLIFY_JWT_EXPIRATION_SECONDS = 14 * 24 * 3600
// cookie's maxAge is in seconds
const LOGIN_COOKIE_MAX_AGE = 30 * 60
const AUTH0_LOGIN_COOKIE_NAME = "auth0_login_cookie"
const NETLIFY_COOKIE_NAME = "nf_jwt"
const isRunningLocally = process.env.NETLIFY_DEV === "true"

/* HS256 signs with bytes, not with a string, and the secret is read at call
   time rather than at import time so a function that never touches a token
   does not care whether TOKEN_SECRET is set. */
const tokenSecret = () => new TextEncoder().encode(process.env.TOKEN_SECRET)

/* Naming the algorithm on the way in is what stops a caller choosing it for
   us by sending a token whose header says something else. */
const VERIFY_OPTIONS = { algorithms: ["HS256"] }

const getOpenIDClient = async () => {
  const issuer = await Issuer.discover(`https://${process.env.AUTH0_DOMAIN}`)
  return new issuer.Client({
    client_id: process.env.AUTH0_CLIENT_ID,
    redirect_uris: [`${process.env.URL}/.netlify/functions/auth/callback`],
    response_types: ["id_token"],
  })
}

//Refer to Netlify Documentation for token formatting - https://docs.netlify.com/visitor-access/role-based-access-control/#external-providers
const signNetlifyJWT = async ({ aud, sub, roles }) => {
  const iat = Math.floor(Date.now() / 1000)
  const exp = Math.floor(iat + NETLIFY_JWT_EXPIRATION_SECONDS)
  const tokenPayload = {
    exp,
    iat,
    updated_at: iat,
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
  return cookie.serialize(AUTH0_LOGIN_COOKIE_NAME, JSON.stringify(cookieData), {
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

const generateEncodedStateString = (route) => {
  const state = { route: route || "/", nonce: generators.nonce() }
  const stateBuffer = Buffer.from(JSON.stringify(state))
  return stateBuffer.toString("base64")
}

/* Both of these clear a cookie, which is `Max-Age=0`. They said `new Date(0)`
   before, and reached the same header only because `serialize` coerces what it
   is handed to a number and the epoch is 0 — `maxAge` is a count of seconds,
   not a date, so any other Date would have been read as its epoch milliseconds
   and set an expiry tens of thousands of years out instead of clearing
   anything. `cookie` 1.x rejects a Date outright, so the coercion was also the
   thing standing between here and the next upgrade. */
const generateAuth0LoginResetCookie = () => {
  return cookie.serialize(AUTH0_LOGIN_COOKIE_NAME, "", {
    secure: !isRunningLocally,
    httpOnly: true,
    path: "/",
    maxAge: 0,
  })
}

const generateLogoutCookie = () => {
  return cookie.serialize(NETLIFY_COOKIE_NAME, "", {
    secure: !isRunningLocally,
    path: "/",
    maxAge: 0,
    httpOnly: true,
  })
}

const generateNetlifyCookie = (netlifyToken) =>
  cookie.serialize(NETLIFY_COOKIE_NAME, netlifyToken, {
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
    ? cookie.parse(cookieHeader)[NETLIFY_COOKIE_NAME]
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
    throw new Error("Malformed event")
  }
  const openIDClient = await getOpenIDClient()
  const referer = event.headers.referer

  const nonce = generators.nonce()
  const state = generateEncodedStateString(referer)
  //authorizationUrl docs - https://github.com/panva/node-openid-client/tree/master/docs#clientauthorizationurlparameters
  const authRedirectURL = openIDClient.authorizationUrl({
    scope: "openid email profile",
    response_mode: "form_post",
    nonce,
    state,
  })
  return {
    statusCode: 302,
    headers: {
      Location: authRedirectURL,
      "Cache-Control": "no-cache",
      "Set-Cookie": generateAuth0LoginCookie(nonce, state),
    },
  }
}

const handleCallback = async (event) => {
  if (!event || !event.headers || !event.headers.cookie) {
    throw new Error("Invalid request")
  }
  const openIDClient = await getOpenIDClient()

  const loginCookie = cookie.parse(event.headers.cookie)[
    AUTH0_LOGIN_COOKIE_NAME
  ]
  const { nonce, state } = JSON.parse(loginCookie)

  /* NOTE: method, body, and url are all required for the openIDClient to work with
    the request*/
  const req = {
    method: "POST",
    body: event.body,
    url: event.headers.host,
  }
  //callbackParams documentation - https://github.com/panva/node-openid-client/tree/master/docs#clientcallbackparamsinput
  const params = openIDClient.callbackParams(req)

  //callback docs - https://github.com/panva/node-openid-client/tree/master/docs#clientcallbackredirecturi-parameters-checks-extras
  const tokenSet = await openIDClient.callback(
    `${process.env.URL}/.netlify/functions/callback`,
    params,
    {
      nonce,
      state,
    }
  )

  const netlifyCookie = await generateNetlifyCookieFromAuth0Token(
    tokenSet.claims()
  )

  const auth0LoginCookie = generateAuth0LoginResetCookie()

  //Get the redirect URL from the decoded state
  const buff = Buffer.from(state, "base64")
  const decodedState = JSON.parse(buff.toString("utf8"))
  return {
    statusCode: 302,
    headers: {
      Location: decodedState.route,
      "Cache-Control": "no-cache",
    },
    multiValueHeaders: {
      "Set-Cookie": [netlifyCookie, auth0LoginCookie],
    },
  }
}

/* Re-issues the nf_jwt cookie with a fresh expiry so that an active session
   slides forward instead of hard-expiring NETLIFY_JWT_EXPIRATION_SECONDS after
   login. The frontend calls this once the current token is past halfway
   through its lifetime. */
const handleRenew = async (event) => {
  const currentToken = getNetlifyJWTFromEvent(event)
  if (!currentToken) {
    return {
      statusCode: 401,
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Not logged in" }),
    }
  }

  let claims
  try {
    /* A token still inside its renewal window verifies fine, so a failure here
       means the session is genuinely over and the user has to log in again. */
    claims = (await jwtVerify(currentToken, tokenSecret(), VERIFY_OPTIONS)).payload
  } catch (err) {
    return {
      statusCode: 401,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": generateLogoutCookie(),
      },
      body: JSON.stringify({ error: "Session expired" }),
    }
  }

  const renewedToken = await signNetlifyJWT({
    aud: claims.aud,
    sub: claims.sub,
    roles: claims.app_metadata?.authorization?.roles,
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

module.exports = {
  handleLogin,
  handleCallback,
  handleLogout,
  handleRenew,
}
