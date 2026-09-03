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
 * #212 fixed the guards and stopped there, which left the two calls that
 * really talk to Auth0 throwing exactly as they always had (#251). Both reject
 * on things that happen to people rather than to attackers: discovery is a
 * round trip on every login and every callback, and the response check rejects
 * for a second login tab or a re-submitted callback. So the rest of this file
 * is what those two answer, and the guards are only half of the subject.
 *
 * A real login still cannot be run here, or on a deploy preview: Netlify sets
 * `URL` to the site's primary url in every context, so a preview's login
 * redirects with `redirect_uri=https://nil.moe/...` and Auth0 posts the
 * callback to production. What stands in for the tenant is the `useLoader`
 * seam in `utils/openid_client`, which exists because the package is ESM-only
 * and no `Module._load` patch reaches it — see `docs/module_system.md`.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed, which is how CI runs the suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('jose')
    await import('cookie')
    // `utils/responses`, which is what these handlers now answer through.
    await import('ts-pattern')
    await import('neverthrow')
    await import('ramda')
    // ESM-only since v6 — see the note in `auth_cookie.test.js`.
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
// The origin a route out of the login cookie is kept or discarded against.
process.env.URL = 'https://nil.moe'
/* Read by `getOpenIDConfiguration` on its way into the stand-in below. Nothing
   dials them, but the tenant url is built out of AUTH0_DOMAIN before the
   stand-in sees it, and one spelled `undefined` is a confusing thing to meet
   in a failure. */
process.env.AUTH0_DOMAIN = 'nil.eu.auth0.com'
process.env.AUTH0_CLIENT_ID = 'a-client-id'

/* `stringifyCookie` builds a `Cookie` *request* header, which is what a
   browser sends and therefore what these fixtures are. It is the wrong half of
   `cookie` 2's API for anything that answers a `Set-Cookie`, and `auth.js`
   uses `stringifySetCookie` for all of those — see the note at the top of it. */
const { stringifyCookie } = dependenciesInstalled ? await import('cookie') : {}
const { JSON_CONTENT_TYPE } = dependenciesInstalled
  ? await import('../utils/responses.js')
  : {}
const { useLoader } = dependenciesInstalled
  ? await import('../utils/openid_client.js')
  : {}
const {
  handleLogin,
  handleCallback,
  readLoginCookie,
  generateEncodedStateString,
} = dependenciesInstalled ? await import('./auth.js') : {}

/** A cookie header carrying `value` as the login cookie, whatever it is. */
const loginCookieHeader = (value) =>
  stringifyCookie({ auth0_login_cookie: value })

/** The header a browser sends back mid-login, for the login that got `route`. */
const goodCookieHeader = (route) =>
  loginCookieHeader(
    JSON.stringify({
      nonce: 'a-nonce',
      state: generateEncodedStateString(route, 'entropy'),
    })
  )

/**
 * Runs `body` with `openid-client` standing in as `stub`, and puts the real
 * loader back however it goes. The seam is module-level state, so a test that
 * leaves its stand-in behind takes the next one with it.
 */
const withLoader = async (stub, body) => {
  useLoader(async () => stub)
  try {
    return await body()
  } finally {
    useLoader(() => import('openid-client'))
  }
}

/** The v6 surface the two handlers reach for, with the happy answer to each. */
const auth0 = {
  discovery: async () => ({}),
  useIdTokenResponseType: () => {},
  None: () => ({}),
  randomNonce: () => 'a-nonce',
  randomState: () => 'entropy',
  buildAuthorizationUrl: () => new URL('https://nil.eu.auth0.com/authorize'),
  implicitAuthentication: async () => ({
    aud: 'a-client-id',
    sub: 'auth0|somebody',
  }),
}

/* A tenant that is not answering, as seen from in here. `fetch failed` is the
   whole of what an undici network error says; the host is added so a test
   below can tell the logged detail apart from the sent body. */
const unreachable = {
  ...auth0,
  discovery: async () => {
    throw new Error('fetch failed: nil.eu.auth0.com')
  },
}

/* And a second login tab. The message is shaped like the library's own, which
   names the claim it compared and both of the values — the reason none of it
   is repeated back to the caller. */
const wontVerify = {
  ...auth0,
  implicitAuthentication: async () => {
    throw new Error(
      'unexpected JWT "nonce" claim value; expected a-nonce, got another'
    )
  },
}

/** A callback as the browser posts it, for a login that got as far as Auth0. */
const callbackEvent = () => ({
  headers: { cookie: goodCookieHeader('https://nil.moe/films') },
  body: 'id_token=header.payload.signature&state=whatever',
})

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
  // Cut down to a path on the way through, which is #229 — the referer this
  // came from is ours, so the only thing lost is the origin. Where a route
  // that is *not* ours goes is `auth_form_post.test.js`.
  assert.equal(login.route, '/films')
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

test('a callback Auth0 will not verify is a 400, not a throw', options, async () => {
  /* #251, and the half of it a user meets: two login tabs, or a back button
     onto a callback that has already been spent. The cookie is good and the
     guards let it through, so this is the first thing past them — and it threw
     out of the handler for as long as the route has existed. */
  const response = await withLoader(wontVerify, () =>
    handleCallback(callbackEvent())
  )

  assert.equal(response.statusCode, 400)
  assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE)
  assert.deepEqual(JSON.parse(response.body), {
    error: 'RequestError',
    message: 'that login could not be completed',
  })
})

test('and nothing the library said comes back with it', options, async () => {
  // Its messages name the claim that mismatched and the values it compared,
  // and this is an answer a stranger can ask for at will.
  const response = await withLoader(wontVerify, () =>
    handleCallback(callbackEvent())
  )

  assert.doesNotMatch(response.body, /nonce|JWT|claim/i)
})

test('a callback Auth0 never answered is ours rather than theirs', options, async (t) => {
  /* The other half. Discovery runs before anything the caller sent is so much
     as looked at, so a 400 here would tell someone whose login was perfectly
     good to go away and try it again. */
  const logged = t.mock.method(console, 'error', () => {})

  const response = await withLoader(unreachable, () =>
    handleCallback(callbackEvent())
  )

  /* 500 rather than the 502 that describes a bad upstream more precisely: a
     502 out of this route is the answer this whole file is about, and cannot
     be told apart from #162 taking every route down at once. */
  assert.equal(response.statusCode, 500)
  assert.deepEqual(JSON.parse(response.body), {
    error: 'InternalError',
    message: 'the login provider did not answer',
  })
  // `detail` is the log's and only the log's, which is what #105 built it for.
  assert.match(logged.mock.calls[0].arguments[0], /fetch failed: nil\.eu\.auth0\.com/)
  assert.doesNotMatch(response.body, /nil\.eu\.auth0\.com/)
})

test('a login Auth0 never answered is the same 500', options, async (t) => {
  // The reproduction in #251 that needs no cookie at all: for as long as the
  // tenant was unreachable, every login anyone started was a 502.
  const logged = t.mock.method(console, 'error', () => {})

  const response = await withLoader(unreachable, () =>
    handleLogin({ headers: { referer: 'https://nil.moe/films' } })
  )

  assert.equal(response.statusCode, 500)
  assert.equal(JSON.parse(response.body).error, 'InternalError')
  assert.match(logged.mock.calls[0].arguments[0], /fetch failed/)
})

test('and a login that works still redirects to Auth0', options, async () => {
  /* The other thing a `try` around the whole of a handler can get wrong is
     catching the success, so this says that it does not. It is also all the
     coverage `handleLogin` has past its guard. */
  const response = await withLoader(auth0, () =>
    handleLogin({ headers: { referer: 'https://nil.moe/films' } })
  )

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.Location, 'https://nil.eu.auth0.com/authorize')
  // The nonce and state it just sent, to be compared with what comes back.
  assert.match(response.headers['Set-Cookie'], /^auth0_login_cookie=/)
})

///////////////////////////////////////////////////////////////////////////////
// The header the login actually sets

/* Nothing in this repo reads a `Set-Cookie` back, so the header these handlers
   build is only ever read by a browser — which means an attribute that stops
   being written is invisible from in here unless it is asserted as a string.
   `cookie` 2 makes that worth doing rather than paranoid: the obvious
   replacement for the old `serialize` is `stringifyCookie`, which answers a
   perfectly good-looking `name=value` with every attribute below silently
   dropped. On this cookie that is `HttpOnly` and `Secure` gone from the thing
   that carries a login's nonce across a cross-site form post. */
test('the login cookie is set with every attribute it needs', options, async () => {
  const response = await withLoader(auth0, () =>
    handleLogin({ headers: { referer: 'https://nil.moe/films' } })
  )

  const state = generateEncodedStateString('https://nil.moe/films', 'entropy')
  const value = encodeURIComponent(
    JSON.stringify({ nonce: 'a-nonce', state })
  )

  /* Spelled out in full rather than matched attribute by attribute, so that an
     attribute *appearing* fails too. `SameSite=None` is the one that has to be
     there: Auth0 posts the callback back cross-site, and a browser sends this
     cookie along on that request only for None — which in turn is only honoured
     alongside `Secure`. `Max-Age=1800` is LOGIN_COOKIE_MAX_AGE, in seconds. */
  assert.equal(
    response.headers['Set-Cookie'],
    `auth0_login_cookie=${value}; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=None`
  )
})

test('and the browser sending it back is a login readLoginCookie reads', options, async () => {
  /* The round trip, end to end and through the real `cookie` both ways: what
     `handleLogin` writes as a `Set-Cookie` is what the browser echoes as a
     `Cookie`, and `readLoginCookie` is what has to get the nonce and the state
     back out of it byte for byte. Percent-encoding is the reason to do this
     rather than trust the two sides separately — the value is JSON, so it is
     encoded on the way out and has to be decoded on the way back in. */
  const response = await withLoader(auth0, () =>
    handleLogin({ headers: { referer: 'https://nil.moe/films?sort=year' } })
  )
  const [nameValue] = response.headers['Set-Cookie'].split(';')

  const login = readLoginCookie(`other=1; ${nameValue}; nf_jwt=something`)

  assert.equal(login.nonce, 'a-nonce')
  assert.equal(
    login.state,
    generateEncodedStateString('https://nil.moe/films?sort=year', 'entropy')
  )
  assert.equal(login.route, '/films?sort=year')
})
