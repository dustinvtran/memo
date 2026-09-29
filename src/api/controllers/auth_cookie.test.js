/**
 * @file The attributes the session cookie is set with, which nothing checked.
 *
 * `nf_jwt` is the whole session — a 14-day HS256 token — and #173 is about
 * the attributes it was missing. The login flow that sets it runs through
 * Auth0 and cannot be exercised here, but `handleRenew` mints the same cookie
 * through the same `generateNetlifyCookie`, needs nothing but a valid token,
 * and is therefore where the attributes can be asserted at all.
 *
 * A deploy preview is not the fallback it looks like: Netlify sets `URL` to
 * the site's primary url in every context, so a preview's `/api/auth/login`
 * redirects with `redirect_uri=https://nil.moe/...` and Auth0 posts the
 * callback to production. The login cookie was set on the preview's domain
 * and is not sent there, so the flow fails on the preview whatever the branch
 * says — which leaves this file and, after a merge, a real login.
 *
 * The session cookie is `httpOnly` since #501, so script on the page cannot
 * read it, and a second cookie — the hint — carries the one thing the page
 * does need, the session's expiry. The two are set and cleared together, and
 * this file is what holds them to that.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('jose')
    await import('cookie')
    /* `openid-client` 6 is ESM-only, so `require` of it is not the question
       this is asking — whether it is installed is, and `require` would answer
       "no" on any loader that will not take an ES module. That would skip this
       file rather than fail it, which is the wrong way round for the tests
       covering the flow with the least coverage. Loading it for real is
       `auth.js`'s job, through an `import()`. */
    await import('openid-client')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

const jose = dependenciesInstalled ? await import('jose') : undefined
const { handleRenew, handleLogout } = dependenciesInstalled
  ? await import('./auth.js')
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

/** Every `Set-Cookie` a response writes, named. */
const setCookiesOf = (response) =>
  Object.fromEntries(
    (response.multiValueHeaders?.['Set-Cookie'] ?? []).map((cookie) => [
      cookie.slice(0, cookie.indexOf('=')),
      cookie,
    ])
  )

const renewal = async () => {
  const token = await sign()
  const response = await handleRenew({
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.statusCode, 200)
  return { response, token, cookies: setCookiesOf(response) }
}

const renewedCookie = async () => (await renewal()).cookies.nf_jwt

test('the session cookie is SameSite=Lax', options, async () => {
  // Lax rather than Strict: the Auth0 callback answers with a redirect and the
  // browser has to send the cookie on that top-level navigation. Lax rather
  // than nothing: an unset SameSite is Lax on Chrome and None elsewhere, and
  // None on a bearer token that never needs to travel cross-site is worth
  // nothing to us and something to a forged request.
  assert.match(await renewedCookie(), /;\s*SameSite=Lax/i)
})

test('the session cookie is Secure, site-wide, and HttpOnly', options, async () => {
  const cookie = await renewedCookie()
  const attributes = attributesOf(cookie)

  assert.equal(attributes.includes('secure'), true)
  assert.match(cookie, /;\s*Path=\//i)
  assert.match(cookie, /;\s*Max-Age=1209600/i)
  // The point of #501: nothing on the page can read the session.
  assert.equal(attributes.includes('httponly'), true)
})

test('the hint beside it carries the expiry and nothing else, readably', options, async () => {
  const { response, cookies } = await renewal()
  const hint = cookies.memo_session
  const attributes = attributesOf(hint)

  const { exp } = jose.decodeJwt(cookies.nf_jwt.split(';')[0].slice('nf_jwt='.length))
  assert.equal(hint.split(';')[0], `memo_session=${exp}`)
  assert.deepEqual(JSON.parse(response.body), { exp })
  // Readable by the page, which is its whole job, and otherwise the session
  // cookie's twin, so the two come and go together.
  assert.equal(attributes.includes('httponly'), false)
  assert.equal(attributes.includes('secure'), true)
  assert.match(hint, /;\s*Path=\//i)
  assert.match(hint, /;\s*Max-Age=1209600/i)
  assert.match(hint, /;\s*SameSite=Lax/i)
})

test('a renewal no longer answers the token in its body', options, async () => {
  const { response, token } = await renewal()

  assert.equal(response.body.includes(token.split('.')[0] + '.'), false)
  assert.equal('token' in JSON.parse(response.body), false)
})

test('logging out clears both cookies', options, async () => {
  // Same name and path, or the browser keeps the one it has alongside it and
  // the session outlives the logout; and a hint left behind would tell the
  // page somebody is still signed in.
  const cookies = setCookiesOf(await handleLogout())

  for (const name of ['nf_jwt', 'memo_session']) {
    assert.match(cookies[name], new RegExp(`^${name}=;`))
    assert.match(cookies[name], /;\s*Path=\//i)
    assert.match(cookies[name], /;\s*Max-Age=0/i)
  }
})
