/**
 * @file The cookies the auth routes set, against the real `cookie`.
 *
 * `stringifySetCookie` is the only thing between these options and a
 * `Set-Cookie` header, and every one of its rules is a runtime rule — there is
 * no type to catch an option it will not accept, and the header it produces is
 * never read back by anything in this repo. So a `cookie` upgrade that
 * tightened a rule would land silently: the tests would stay green, the build
 * would pass, and the first sign of it would be a 502 on `/api/auth/logout`
 * or, worse, a clearing cookie that quietly expires in fifty thousand years.
 *
 * That is not hypothetical. `maxAge` used to be `new Date(0)` here, which
 * worked by coercion; `cookie` 1.x rejects it outright and 2.x still does.
 *
 * Nor is the other direction. `cookie` 2 renamed `serialize` to
 * `stringifySetCookie` and put a `stringifyCookie` beside it that builds a
 * `Cookie` request header — same shape of answer, none of the attributes
 * below — so "the tests stay green while the cookie loses `Secure`" is one
 * plausible import away. Which is why the attributes are read back off the
 * header here rather than assumed from the options.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('cookie')
    await import('jose')
    // ESM-only since v6 — see the note in `auth_cookie.test.js`.
    await import('openid-client')
    await import('ts-pattern')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

/* `parseSetCookie` is `cookie` 2's reader for the header these handlers write,
   and it is what the hand-rolled splitting below used to stand in for: the old
   `parse` read a `Set-Cookie` as though it were a `Cookie` request header, so
   it could answer the name and value and nothing else. */
const { parseSetCookie } = dependenciesInstalled ? await import('cookie') : {}
const jose = dependenciesInstalled ? await import('jose') : undefined
const { handleLogout, handleRenew } = dependenciesInstalled
  ? await import('./auth.js')
  : {}

const NETLIFY_COOKIE_NAME = 'nf_jwt'

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
  assert.deepEqual(parseSetCookie(setCookie), {
    name: NETLIFY_COOKIE_NAME,
    value: '',
    maxAge: 0,
    path: '/',
    httpOnly: true,
    secure: true,
  })
})

test('a session past saving is cleared the same way', options, async () => {
  // The 401 branch of renew. It clears rather than merely refusing, so that a
  // token the server will never accept again stops being sent.
  const stale = await sign({ key: new TextEncoder().encode('another secret') })
  const { statusCode, headers } = await handleRenew({
    headers: { authorization: `Bearer ${stale}` },
  })

  assert.equal(statusCode, 401)
  const cleared = parseSetCookie(headers['Set-Cookie'])
  assert.equal(cleared.name, NETLIFY_COOKIE_NAME)
  assert.equal(cleared.value, '')
  assert.equal(cleared.maxAge, 0)
})

test('a renewed token survives the round trip through a cookie', options, async () => {
  /* A JWT is dots and base64url, all of which `stringifySetCookie` allows
     unencoded — but that is `cookie`'s judgement, not ours, and this is the
     assertion that notices if it ever stops being true. `cookie` 2 changed the
     default encoder: it now skips `encodeURIComponent` for values that survive
     the round trip unchanged, rather than always calling it. The header is
     different because of that, and a token read back out of it must not be. */
  const { statusCode, headers, body } = await handleRenew({
    headers: { authorization: `Bearer ${await sign()}` },
  })
  const setCookie = headers['Set-Cookie']

  assert.equal(statusCode, 200)
  assert.equal(parseSetCookie(setCookie).value, JSON.parse(body).token)
  // The renewed cookie is the one whose `maxAge` is a real duration, so it
  // pins the units as well: seconds, not milliseconds.
  assert.equal(parseSetCookie(setCookie).maxAge, 14 * 24 * 3600)
})

test('no token at all is refused without a cookie to clear', options, async () => {
  const { statusCode, headers } = await handleRenew({ headers: {} })

  assert.equal(statusCode, 401)
  assert.equal(headers['Set-Cookie'], undefined)
})
