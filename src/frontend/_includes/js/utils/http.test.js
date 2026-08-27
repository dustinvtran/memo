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
  // Every request reads the token through here, so a stray `%` in some other
  // service's cookie must not take the session with it.
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

/** Where `renewToken` goes. Named here so a test can answer that url alone. */
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
    // global: no `fetch`, and no `atob` for `secondsUntilExpiry` to read the
    // token's expiry with.
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    fetch: async (url, options) => {
      calls.push({ url, ...options })
      return asResponse(answer(url, options))
    },
    // Two globals belonging to other bundled files. `Nullable.map` is
    // nullable.js's, to the letter; `NT` is the vendored neverthrow, and the
    // only thing this file asks of `fromPromise` is that the mapper runs on a
    // rejection and not on a value — which is exactly what the port below
    // turns on, so it is worth the stub saying so rather than mocking it away.
    Nullable: {
      map: (value, fn) =>
        value === null || value === undefined ? value : fn(value),
    },
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

  const { Http, renewToken } = vm.runInContext(
    `(() => {\n${source}\n;return ({ Http, renewToken })\n})()`,
    context
  )

  return { Http, renewToken, calls, context }
}

/** A token with a real `exp`, since that is what decides whether to renew. */
const jwtExpiringIn = (seconds) => {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const WEEKS = 30 * 24 * 3600
const AN_HOUR = 3600

test('a patch goes out as one, with a JSON body and the token', async () => {
  const token = jwtExpiringIn(WEEKS)
  const { Http, calls, context } = loadWithFetch(() => ({ body: { score: 9 } }))
  context.document.cookie = `nf_jwt=${token}`

  const result = await Http.patch('/.netlify/functions/entries/films/abc', {
    score: 9,
  })

  // One call: the token has weeks left, so nothing is renewed first.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].headers.Authorization, `Bearer ${token}`)
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
  // Logged out: there is no token to send, and an `Authorization: Bearer
  // undefined` is worse than no header at all.
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

test('a renewal that fails hands back the token, not undefined', async () => {
  // The bug a literal port ships: a renewal fails with a 401, `fetch` resolves
  // on it, the `.catch(() => token)` never runs, and `body.token` off the
  // *error* body is `undefined` — a renewal reporting success and handing back
  // nothing. Asked of `renewToken` directly, because the caller's
  // `jwt ?? getToken()` reads the cookie when this resolves undefined and so
  // hides it: the next test is the one that would still pass.
  const token = jwtExpiringIn(AN_HOUR)
  const { renewToken } = loadWithFetch(() => ({
    status: 401,
    body: { error: 'UnauthorizedError', message: 'not authorized' },
  }))

  assert.equal(await renewToken(token), token)
})

test('a failed renewal leaves the request carrying the token it had', async () => {
  // The end of that path: whatever `renewToken` decides, the request it held
  // up goes out with a usable token on it and succeeds.
  const token = jwtExpiringIn(AN_HOUR)
  const { Http, calls, context } = loadWithFetch((url) =>
    url === RENEWAL_URL
      ? { status: 401, body: { error: 'UnauthorizedError', message: 'not authorized' } }
      : { body: {} }
  )
  context.document.cookie = `nf_jwt=${token}`

  const result = await Http.get('/.netlify/functions/name')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, RENEWAL_URL)
  assert.notEqual(calls[1].headers.Authorization, 'Bearer undefined')
  assert.equal(calls[1].headers.Authorization, `Bearer ${token}`)
  // And the request itself is unharmed: a renewal that fails is not a failure.
  assert.equal(result.ok, true)
})

test('a renewal that succeeds puts the new token on the request', async () => {
  const token = jwtExpiringIn(AN_HOUR)
  const { Http, calls, context } = loadWithFetch((url) =>
    url === RENEWAL_URL ? { body: { token: 'renewed.jwt.here' } } : { body: {} }
  )
  context.document.cookie = `nf_jwt=${token}`

  await Http.get('/.netlify/functions/name')

  assert.equal(calls[0].headers.Authorization, `Bearer ${token}`)
  assert.equal(calls[1].headers.Authorization, 'Bearer renewed.jwt.here')
})

test('two requests at once renew once', async () => {
  const token = jwtExpiringIn(AN_HOUR)
  const { Http, calls, context } = loadWithFetch((url) =>
    url === RENEWAL_URL ? { body: { token: 'renewed.jwt.here' } } : { body: {} }
  )
  context.document.cookie = `nf_jwt=${token}`

  await Promise.all([
    Http.get('/.netlify/functions/name'),
    Http.get('/.netlify/functions/stats/nil'),
  ])

  assert.equal(calls.filter(({ url }) => url === RENEWAL_URL).length, 1)
})
