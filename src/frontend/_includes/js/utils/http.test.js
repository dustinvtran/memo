/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this evaluates http.js in a vm context and pulls the
 * private functions out of the script's scope.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, 'http.js'), 'utf8')

// Nothing else the file names is reached at load time: it builds `Http` out of
// functions that read `window`, `fetch` and `NT` only when they are called.
const context = vm.createContext({ document: { cookie: '' } })

// The `js()` macro in bundle.njk wraps each bundled file in its own IIFE,
// which is what keeps two files' `const`s from colliding. Loading it the same
// way here keeps that difference visible.
const { toRequestError, errorMessage, cookies } = vm.runInContext(
  `(() => {\n${source}\n;return ({ toRequestError, errorMessage, cookies })\n})()`,
  context
)

/** An object built inside the vm has that realm's prototype, not this one's. */
const plain = (object) => ({ ...object })

/** A failed request as `request` hands it over: the status, and the body. */
const failure = (status, body) => ({ response: { status, data: body } })

test('the line the API wrote for the caller survives the trip', () => {
  assert.deepEqual(
    plain(toRequestError(failure(400, {
      error: 'RequestError',
      message: 'the request body is not valid',
    }))),
    {
      status: 400,
      error: 'RequestError',
      message: 'the request body is not valid',
    }
  )
})

test('the status is kept, so a 401 can be told apart from a 500', () => {
  // Not acted on here — #216 is where "log in again" rather than "try again"
  // gets decided — but it cannot be acted on at all unless it survives.
  const err = toRequestError(failure(401, {
    error: 'UnauthorizedError',
    message: 'not authorized',
  }))
  assert.equal(err.status, 401)
})

test('a request that never got an answer still reports something', () => {
  // A dropped connection or a timeout: there is no response to report, so
  // there is no status and no message, and the fallback is all there is.
  const err = toRequestError(new Error('Network Error'))
  assert.deepEqual(plain(err), {
    status: 500,
    error: undefined,
    message: undefined,
  })
  assert.equal(errorMessage(err), 'something went wrong')
})

test('what is shown is the message, never the class name', () => {
  const err = toRequestError(failure(404, {
    error: 'NotFound',
    message: 'no such game',
  }))
  assert.equal(errorMessage(err), 'no such game')
})

test('errorMessage falls back for anything carrying no message', () => {
  assert.equal(errorMessage(undefined), 'something went wrong')
  assert.equal(errorMessage({ status: 502 }), 'something went wrong')
  // `WithRemoteData` takes plain promises too, and a rejected one arrives as
  // an `Error`, which this reads just as happily.
  assert.equal(errorMessage(new Error('boom')), 'boom')
})

const withCookie = (cookie) => {
  context.document.cookie = cookie
  return plain(cookies())
}

test('a cookie value containing = comes back whole', () => {
  // The token is unpadded base64url today, so it survives being split on
  // every `=`. Nothing about it promises to stay that way.
  assert.equal(
    withCookie('nf_jwt=aGVhZGVy.cGF5bG9hZA==').nf_jwt,
    'aGVhZGVy.cGF5bG9hZA=='
  )
})

test('a percent-encoded value is decoded', () => {
  assert.equal(withCookie('greeting=hello%20there').greeting, 'hello there')
})

test('a value that cannot be decoded is left alone rather than thrown over', () => {
  // Every request reads the session hint through here, so a stray `%` in some
  // other service's cookie must not take the session with it.
  assert.equal(withCookie('nf_jwt=token; other=100%').nf_jwt, 'token')
  assert.equal(withCookie('nf_jwt=token; other=100%').other, '100%')
})

test('several cookies, however they are spaced', () => {
  assert.deepEqual(withCookie('a=1;b=2; c=3'), { a: '1', b: '2', c: '3' })
})

test('no cookies at all is no cookies, rather than one empty one', () => {
  assert.deepEqual(withCookie(''), {})
})

///////////////////////////////////////////////////////////////////////////////
// The request itself, against a `fetch` that answers from a script.

/** Where `renewSession` goes. Named here so a test can answer that url alone. */
const RENEWAL_URL = '/.netlify/functions/auth/renew'

/** Enough of a `Response` for `request` to read: `ok`, `status` and `text`. */
const asResponse = ({ status = 200, body } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  text: async () =>
    body === undefined
      ? ''
      : typeof body === 'string'
      ? body
      : JSON.stringify(body),
})

/**
 * A fresh load of the file with the globals a *request* reaches for, and a
 * `fetch` that answers from `answer(url, options)` and records what it was
 * asked. Fresh each time because the renewal state — `pendingRenewal` — is a
 * `let` in that scope, and a test that renews would otherwise leave it set for
 * the next one.
 */
const loadWithFetch = (answer) => {
  const calls = []

  const context = vm.createContext({
    document: { cookie: '' },
    // A vm context is its own realm, so it has none of what Node adds to the
    // global: no `fetch`, and no `atob` for `expOfJwt` to read a pre-#501
    // session's expiry with.
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    fetch: async (url, options) => {
      calls.push({ url, ...options })
      return asResponse(answer(url, options))
    },
    // The vendored neverthrow, and the only thing this file asks of
    // `fromPromise` is that the mapper runs on a rejection and not on a value
    // — which is exactly what the port below turns on, so it is worth the stub
    // saying so rather than mocking it away.
    NT: {
      ResultAsync: {
        fromPromise: (promise, mapErr) =>
          promise.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error: plain(mapErr(error)) })
          ),
      },
    },
  })

  const { Http } = vm.runInContext(
    `(() => {\n${source}\n;return ({ Http })\n})()`,
    context
  )

  return { Http, calls, context }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** The hint the server sets beside the session: its `exp`, and nothing else. */
const hintExpiringIn = (seconds) => `memo_session=${nowSeconds() + seconds}`

/** A readable session cookie from before #501, with a real `exp`. */
const legacyJwtExpiringIn = (seconds) => {
  const payload = Buffer.from(
    JSON.stringify({ exp: nowSeconds() + seconds })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const MONTHS = 300 * 24 * 3600
const AN_HOUR = 3600

test('a patch goes out as one, with a JSON body, the cookie and the CSRF header', async () => {
  const { Http, calls, context } = loadWithFetch(() => ({ body: { score: 9 } }))
  context.document.cookie = hintExpiringIn(MONTHS)

  const result = await Http.patch('/.netlify/functions/entries/films/abc', {
    score: 9,
  })

  // One call: the session has most of its 400 days left, so nothing is
  // renewed first.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'PATCH')
  // The session travels as the cookie, which the page cannot read and so
  // cannot repeat; the header is what lets the API accept a cookie-signed
  // write at all.
  assert.equal(calls[0].credentials, 'same-origin')
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.equal(calls[0].headers['X-Requested-With'], 'memo')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), { score: 9 })
  assert.equal(result.ok, true)
  assert.deepEqual(plain(result.value), { score: 9 })
})

test('a read carries no body and no content type', async () => {
  const { Http, calls } = loadWithFetch(() => ({ body: [] }))

  await Http.get('/.netlify/functions/entries/films/nil')

  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].body, undefined)
  assert.equal(calls[0].headers['Content-Type'], undefined)
  assert.equal(calls[0].headers.Authorization, undefined)
})

test('a 4xx is a failure, and the line the API wrote reaches the caller', async () => {
  // The trap the whole port turns on: `fetch` resolves for a 404 exactly as it
  // does for a 200 — the status is on `ok` and nothing is thrown — so without
  // `request` turning that back into a rejection this arrives as a *success*
  // holding the error body, and every message downstream reads a field of it
  // that is not there.
  const { Http } = loadWithFetch(() => ({
    status: 404,
    body: { error: 'NotFound', message: 'no such game' },
  }))

  const result = await Http.get('/.netlify/functions/entries/games/nobody')

  assert.equal(result.ok, false)
  assert.deepEqual(result.error, {
    status: 404,
    error: 'NotFound',
    message: 'no such game',
  })
  assert.equal(errorMessage(result.error), 'no such game')
})

test('an error page that is not our own JSON still lands on the fallback', async () => {
  // A proxy, a CDN or Netlify itself answering before the function does. The
  // body is html, so parsing it has to fail quietly on the way to the message
  // of last resort rather than throwing over the failure it is describing.
  const { Http } = loadWithFetch(() => ({
    status: 502,
    body: '<html><body>Bad gateway</body></html>',
  }))

  const result = await Http.get('/.netlify/functions/name')

  assert.deepEqual(result.error, {
    status: 502,
    error: undefined,
    message: undefined,
  })
  assert.equal(errorMessage(result.error), 'something went wrong')
})

test('a 200 with nothing in it is an answer, not a parse error', async () => {
  // `del` gets one of these, and `response.json()` throws on an empty body
  // rather than answering `undefined`.
  const { Http } = loadWithFetch(() => ({ status: 200 }))

  const result = await Http.del('/.netlify/functions/entries/films/abc')

  assert.deepEqual(plain(result), { ok: true, value: undefined })
})

///////////////////////////////////////////////////////////////////////////////
// Whether there is a session, and keeping it alive

test('the hint is what says someone is signed in', () => {
  const { Http, context } = loadWithFetch(() => ({}))

  context.document.cookie = ''
  assert.equal(Http.hasSession(), false)

  context.document.cookie = hintExpiringIn(MONTHS)
  assert.equal(Http.hasSession(), true)

  // A hint that is not a number is no session, rather than one expiring at NaN.
  context.document.cookie = 'memo_session=garbage'
  assert.equal(Http.hasSession(), false)
})

test('a readable session from before #501 still counts, until it is renewed', () => {
  const { Http, context } = loadWithFetch(() => ({}))

  context.document.cookie = `nf_jwt=${legacyJwtExpiringIn(MONTHS)}`
  assert.equal(Http.hasSession(), true)
})

test('a session past halfway is renewed before the request', async () => {
  const { Http, calls, context } = loadWithFetch(() => ({ body: {} }))
  context.document.cookie = hintExpiringIn(AN_HOUR)

  await Http.get('/.netlify/functions/name')

  assert.deepEqual(calls.map(({ url }) => url), [RENEWAL_URL, '/.netlify/functions/name'])
  assert.equal(calls[0].credentials, 'same-origin')
})

test('a pre-#501 session is renewed on the first request, however long it has left', async () => {
  // The renewal is what replaces the readable cookie with the httpOnly one and
  // sets the hint, so it cannot wait for the halfway mark.
  const { Http, calls, context } = loadWithFetch(() => ({ body: {} }))
  context.document.cookie = `nf_jwt=${legacyJwtExpiringIn(MONTHS)}`

  await Http.get('/.netlify/functions/name')

  assert.equal(calls[0].url, RENEWAL_URL)
})

test('a failed renewal does not fail the request it held up', async () => {
  const { Http, calls, context } = loadWithFetch((url) =>
    url === RENEWAL_URL
      ? { status: 401, body: { error: 'UnauthorizedError', message: 'not authorized' } }
      : { body: { username: 'nil' } }
  )
  context.document.cookie = hintExpiringIn(AN_HOUR)

  const result = await Http.get('/.netlify/functions/name')

  assert.equal(calls.length, 2)
  assert.equal(result.ok, true)
  assert.deepEqual(plain(result.value), { username: 'nil' })
})

test('two requests at once renew once', async () => {
  const { Http, calls, context } = loadWithFetch(() => ({ body: {} }))
  context.document.cookie = hintExpiringIn(AN_HOUR)

  await Promise.all([
    Http.get('/.netlify/functions/name'),
    Http.get('/.netlify/functions/stats/nil'),
  ])

  assert.equal(calls.filter(({ url }) => url === RENEWAL_URL).length, 1)
})

test('signed out, nothing is renewed', async () => {
  const { Http, calls } = loadWithFetch(() => ({ body: {} }))

  await Http.get('/.netlify/functions/name')

  assert.deepEqual(calls.map(({ url }) => url), ['/.netlify/functions/name'])
})
