/**
 * @file The attributes the session cookie is set with, which nothing checked.
 *
 * `nf_jwt` is the whole session — a 14-day HS256 token — and #173 is about
 * the attributes it was missing. The login flow that sets it runs through
 * Auth0 and cannot be exercised here, but `handleRenew` mints the same cookie
 * through the same `generateNetlifyCookie`, needs nothing but a valid token,
 * and is therefore where the attributes can be asserted at all.
 *
 * The `httpOnly` assertion is inverted on purpose: it is deliberately absent,
 * because `Http.getToken` reads this cookie out of `document.cookie`. Turning
 * it on is a separate change that has to move the API to cookie-borne auth
 * first, and this test is what makes that a decision rather than a surprise.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('jose')
    require('cookie')
    require('openid-client')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

const jose = dependenciesInstalled ? require('jose') : undefined
const { handleRenew, handleLogout } = dependenciesInstalled
  ? require('./auth')
  : {}

const secret = () => new TextEncoder().encode(process.env.TOKEN_SECRET)

/** A token shaped like the one `signNetlifyJWT` mints. */
const sign = () => {
  const iat = Math.floor(Date.now() / 1000)
  return new jose.SignJWT({
    exp: iat + 14 * 24 * 3600,
    iat,
    updated_at: iat,
    aud: 'memo',
    sub: 'auth0|nil',
    app_metadata: { authorization: { roles: ['user'] } },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(secret())
}

/** The attributes of a `Set-Cookie`, lowercased, without their values. */
const attributesOf = (setCookie) =>
  setCookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().split('=')[0].toLowerCase())

const renewedCookie = async () => {
  const response = await handleRenew({
    headers: { authorization: `Bearer ${await sign()}` },
  })
  assert.equal(response.statusCode, 200)
  return response.headers['Set-Cookie']
}

test('the session cookie is SameSite=Lax', options, async () => {
  // Lax rather than Strict: the Auth0 callback answers with a redirect and the
  // browser has to send the cookie on that top-level navigation. Lax rather
  // than nothing: an unset SameSite is Lax on Chrome and None elsewhere, and
  // None on a bearer token that never needs to travel cross-site is worth
  // nothing to us and something to a forged request.
  assert.match(await renewedCookie(), /;\s*SameSite=Lax/i)
})

test('the session cookie is Secure, site-wide, and not HttpOnly', options, async () => {
  const cookie = await renewedCookie()
  const attributes = attributesOf(cookie)

  assert.equal(attributes.includes('secure'), true)
  assert.match(cookie, /;\s*Path=\//i)
  assert.match(cookie, /;\s*Max-Age=1209600/i)
  // Not a wish list: the frontend reads this cookie from `document.cookie`, so
  // `httpOnly` here would log everyone out. See the file comment.
  assert.equal(attributes.includes('httponly'), false)
})

test('logging out clears the same cookie', options, async () => {
  // Same name and path, or the browser keeps the one it has alongside it and
  // the session outlives the logout.
  const response = await handleLogout()
  const cookie = response.headers['Set-Cookie']

  assert.match(cookie, /^nf_jwt=;/)
  assert.match(cookie, /;\s*Path=\//i)
})
