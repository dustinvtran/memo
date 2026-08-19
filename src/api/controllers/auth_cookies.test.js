/**
 * @file The cookies the auth routes set, against the real `cookie`.
 *
 * `serialize` is the only thing between these options and a `Set-Cookie`
 * header, and every one of its rules is a runtime rule — there is no type to
 * catch an option it will not accept, and the header it produces is never read
 * back by anything in this repo. So a `cookie` upgrade that tightened a rule
 * would land silently: the tests would stay green, the build would pass, and
 * the first sign of it would be a 502 on `/api/auth/logout` or, worse, a
 * clearing cookie that quietly expires in fifty thousand years.
 *
 * That is not hypothetical. `maxAge` used to be `new Date(0)` here, which
 * worked by coercion; `cookie` 1.x rejects it outright.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('cookie')
    require('jose')
    require('openid-client')
    require('ts-pattern')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

const cookie = dependenciesInstalled ? require('cookie') : undefined
const jose = dependenciesInstalled ? require('jose') : undefined
const { handleLogout, handleRenew } = dependenciesInstalled
  ? require('./auth')
  : {}

const NETLIFY_COOKIE_NAME = 'nf_jwt'

/** The attributes of a `Set-Cookie`, by name, alongside `cookie.parse`. */
const attributesOf = (setCookie) =>
  new Map(
    setCookie
      .split(';')
      .slice(1)
      .map((part) => {
        const [key, ...rest] = part.trim().split('=')
        return [key.toLowerCase(), rest.join('=')]
      })
  )

/** A token shaped like the one `signNetlifyJWT` mints. */
const sign = ({ key = new TextEncoder().encode(process.env.TOKEN_SECRET) } = {}) => {
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
    .sign(key)
}

test('logging out clears the session cookie', options, async () => {
  const { headers } = await handleLogout()
  const setCookie = headers['Set-Cookie']

  // `Max-Age=0` is the whole point: an empty value alone leaves a cookie the
  // browser keeps sending. Anything other than 0 here is a session that does
  // not end.
  assert.equal(cookie.parse(setCookie)[NETLIFY_COOKIE_NAME], '')
  assert.equal(attributesOf(setCookie).get('max-age'), '0')
  assert.equal(attributesOf(setCookie).has('httponly'), true)
  assert.equal(attributesOf(setCookie).has('secure'), true)
  assert.equal(attributesOf(setCookie).get('path'), '/')
})

test('a session past saving is cleared the same way', options, async () => {
  // The 401 branch of renew. It clears rather than merely refusing, so that a
  // token the server will never accept again stops being sent.
  const stale = await sign({ key: new TextEncoder().encode('another secret') })
  const { statusCode, headers } = await handleRenew({
    headers: { authorization: `Bearer ${stale}` },
  })

  assert.equal(statusCode, 401)
  assert.equal(cookie.parse(headers['Set-Cookie'])[NETLIFY_COOKIE_NAME], '')
  assert.equal(attributesOf(headers['Set-Cookie']).get('max-age'), '0')
})

test('a renewed token survives the round trip through a cookie', options, async () => {
  // A JWT is dots and base64url, all of which `serialize` allows unencoded —
  // but that is `cookie`'s judgement, not ours, and this is the assertion that
  // notices if it ever stops being true. The renewed cookie is also the one
  // whose `maxAge` is a real duration, so it pins the units as well: seconds,
  // not milliseconds.
  const { statusCode, headers, body } = await handleRenew({
    headers: { authorization: `Bearer ${await sign()}` },
  })
  const setCookie = headers['Set-Cookie']

  assert.equal(statusCode, 200)
  assert.equal(cookie.parse(setCookie)[NETLIFY_COOKIE_NAME], JSON.parse(body).token)
  assert.equal(attributesOf(setCookie).get('max-age'), String(14 * 24 * 3600))
})

test('no token at all is refused without a cookie to clear', options, async () => {
  const { statusCode, headers } = await handleRenew({ headers: {} })

  assert.equal(statusCode, 401)
  assert.equal(headers['Set-Cookie'], undefined)
})
