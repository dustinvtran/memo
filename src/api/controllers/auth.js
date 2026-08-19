// file mostly copypasted from:
// https://github.com/jamesqquick/netlify-auth0-rbac-integration-demo/blob/master/functions/AuthUtils.js
const { Issuer, generators } = require("openid-client")
const { SignJWT, jwtVerify } = require("jose")
const cookie = require("cookie")
const {
  VERIFY_OPTIONS,
  isWithinAbsoluteLifetime,
  sessionStartedAt,
  tokenSecret,
} = require("../utils/session_token")

const NETLIFY_JWT_EXPIRATION_SECONDS = 14 * 24 * 3600
// cookie's maxAge is in seconds
const LOGIN_COOKIE_MAX_AGE = 30 * 60
const AUTH0_LOGIN_COOKIE_NAME = "auth0_login_cookie"
const NETLIFY_COOKIE_NAME = "nf_jwt"
const isRunningLocally = process.env.NETLIFY_DEV === "true"

const getOpenIDClient = async () => {
  const issuer = await Issuer.discover(`https://${process.env.AUTH0_DOMAIN}`)
  return new issuer.Client({
    client_id: process.env.AUTH0_CLIENT_ID,
    redirect_uris: [`${process.env.URL}/.netlify/functions/auth/callback`],
    response_types: ["id_token"],
  })
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

const generateAuth0LoginResetCookie = () => {
  return cookie.serialize(AUTH0_LOGIN_COOKIE_NAME, "", {
    secure: !isRunningLocally,
    httpOnly: true,
    path: "/",
    maxAge: new Date(0),
  })
}

const generateLogoutCookie = () => {
  return cookie.serialize(NETLIFY_COOKIE_NAME, "", {
    secure: !isRunningLocally,
    path: "/",
    maxAge: new Date(0),
    httpOnly: true,
  })
}

const generateNetlifyCookie = (netlifyToken) =>
  cookie.serialize(NETLIFY_COOKIE_NAME, netlifyToken, {
    secure: !isRunningLocally,
    path: "/",
    maxAge: NETLIFY_JWT_EXPIRATION_SECONDS,
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

module.exports = {
  handleLogin,
  handleCallback,
  handleLogout,
  handleRenew,
}
