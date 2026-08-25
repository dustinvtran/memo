/**
 * @file What the two Auth0 handlers answer a request they cannot read.
 *
 * Both used to `throw`, and an uncaught throw out of a Netlify function is a
 * 502 — so `curl -X POST https://nil.moe/api/auth/callback` with no cookie
 * answered 502 rather than a 4xx, for as long as the route has existed.
 *
 * That is worth a test rather than just a fix, because the 502 was not merely
 * the wrong number. It is the same answer an ESM-only dependency gives when it
 * throws while the module is read and takes every route down at once (#162,
 * #185), and this route is on the shortest path anyone checks that with. A
 * standing false positive on the one signal is the kind of thing that comes
 * back the next time a guard is written in a hurry.
 *
 * The flow around these guards still cannot be exercised here, or on a deploy
 * preview: Netlify sets `URL` to the site's primary url in every context, so a
 * preview's login redirects with `redirect_uri=https://nil.moe/...` and Auth0
 * posts the callback to production. What *is* reachable is everything before
 * the network — `readLoginCookie` decides the whole of it, and both handlers
 * answer from it without asking Auth0 anything — so that is what this asserts.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed, which is how CI runs the suite.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('jose')
    require('cookie')
    // `utils/responses`, which is what these handlers now answer through.
    require('ts-pattern')
    require('neverthrow')
    require('ramda')
    // ESM-only since v6 — see the note in `auth_cookie.test.js`.
    require.resolve('openid-client/package.json')
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
const { JSON_CONTENT_TYPE } = dependenciesInstalled
  ? require('../utils/responses')
  : {}
const {
  handleLogin,
  handleCallback,
  readLoginCookie,
  generateEncodedStateString,
} = dependenciesInstalled ? require('./auth') : {}

/** A cookie header carrying `value` as the login cookie, whatever it is. */
const loginCookieHeader = (value) =>
  cookie.serialize('auth0_login_cookie', value)

/** The header a browser sends back mid-login, for the login that got `route`. */
const goodCookieHeader = (route) =>
  loginCookieHeader(
    JSON.stringify({
      nonce: 'a-nonce',
      state: generateEncodedStateString(route, 'entropy'),
    })
  )

/**
 * Every way a callback can arrive without a login behind it. None of them
 * reaches `openidClient.load()`, which is why this file needs no stand-in for
 * Auth0 and no network.
 *
 * Built on call rather than at module load, because `cookie` is `undefined`
 * until the check above says otherwise and a table built at load time runs
 * before `skip` can decide anything. The suite runs with no install; a fixture
 * that needs one has to be behind a function.
 */
const unreadableCookieHeaders = () => ({
  'no cookie header at all': undefined,
  'no headers at all': null,
  'cookies, but not ours': 'other=1; nf_jwt=something',
  'ours, but not JSON': loginCookieHeader('not json'),
  'ours, but JSON that is not an object': loginCookieHeader('"a string"'),
  'ours, but missing the nonce': loginCookieHeader(
    JSON.stringify({ state: generateEncodedStateString('/', 'entropy') })
  ),
  'ours, but missing the state': loginCookieHeader(
    JSON.stringify({ nonce: 'a-nonce' })
  ),
  'ours, but a state that does not decode to our JSON': loginCookieHeader(
    JSON.stringify({ nonce: 'a-nonce', state: 'bm90IGpzb24=' })
  ),
  'ours, but a state carrying no route': loginCookieHeader(
    JSON.stringify({
      nonce: 'a-nonce',
      state: Buffer.from(JSON.stringify({ nonce: 'e' })).toString('base64'),
    })
  ),
})

/** The event shape the route hands the handler. */
const asEvent = (cookieHeader) =>
  cookieHeader === null ? {} : { headers: { cookie: cookieHeader } }

test('a callback with no login behind it is a 400, not a throw', options, async (t) => {
  for (const [name, header] of Object.entries(unreadableCookieHeaders())) {
    await t.test(name, async () => {
      const response = await handleCallback(asEvent(header))

      assert.equal(response.statusCode, 400)
    })
  }
})

test('and it is a 400 the caller can read', options, async () => {
  // The rest of the API answers a failure as JSON through `utils/responses`,
  // and says which class of failure it was. A 502 is a Netlify error page.
  const response = await handleCallback(asEvent(undefined))

  assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE)
  assert.deepEqual(JSON.parse(response.body), {
    error: 'RequestError',
    message: 'no login in progress',
  })
})

test('nothing about the cookie reaches the caller', options, async () => {
  // Which of the nine ways above it was is the log's business. All the caller
  // is told is that there is no login here to finish.
  const responses = await Promise.all(
    Object.values(unreadableCookieHeaders()).map((header) =>
      handleCallback(asEvent(header))
    )
  )
  const bodies = new Set(responses.map((response) => response.body))

  assert.equal(bodies.size, 1)
})

test('handleLogin answers the same way, rather than throwing', options, async () => {
  // It threw `Malformed event` for the same class of request, and reached the
  // client the same way. Nothing else in this file goes near `handleLogin`,
  // because everything past this guard is a discovery request to Auth0.
  const response = await handleLogin({})

  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error, 'RequestError')
})

test('a real login cookie is read, not refused', options, () => {
  // The guard has to let the ordinary case through, and the tests above cannot
  // tell "refused everything" from "refused the right things".
  const login = readLoginCookie(goodCookieHeader('https://nil.moe/films'))

  assert.equal(login.nonce, 'a-nonce')
  assert.equal(login.route, 'https://nil.moe/films')
})

test('the state is handed on byte for byte', options, () => {
  // `implicitAuthentication` gets it as `expectedState` and compares it to what
  // Auth0 echoed back, so a state read loosely here is a login that fails at
  // the last step for no visible reason.
  const state = generateEncodedStateString('/', 'entropy')
  const login = readLoginCookie(loginCookieHeader(JSON.stringify({ nonce: 'n', state })))

  assert.equal(login.state, state)
})

test('a login with no referer redirects to the root', options, () => {
  // `generateEncodedStateString` defaults the route, so this arrives as a
  // route rather than as a cookie to refuse.
  assert.equal(readLoginCookie(goodCookieHeader(undefined)).route, '/')
})
