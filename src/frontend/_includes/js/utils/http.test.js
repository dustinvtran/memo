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
// functions that read `window`, `axios` and `NT` only when they are called.
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

/** A failed request as axios hands it over, answered by our own API. */
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
  // A dropped connection or a timeout: axios has no response to report, so
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
