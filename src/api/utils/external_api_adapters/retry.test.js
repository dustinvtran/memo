const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  ATTEMPTS,
  MAX_DELAY_MS,
  backoffMs,
  describeFailure,
  isTransient,
  retrying,
  statusOf,
} = require('./retry')

/** A 503 exactly as axios throws it — the Google Books failure in issue #80. */
const axiosError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  })

/** `got`'s HTTPError, which node-themoviedb rethrows for anything non-4xx. */
const gotError = (statusCode) =>
  Object.assign(new Error('Response code 503 (Service Unavailable)'), {
    name: 'HTTPError',
    response: { statusCode },
  })

/** node-themoviedb's own error classes, which carry `errorCode`. */
const tmdbError = (errorCode) =>
  Object.assign(new Error('Too many requests per IP'), { code: 0, errorCode })

/** A dead connection, which carries no status at all. */
const networkError = (code) =>
  Object.assign(new Error('socket hang up'), { code })

/** Resolves at once, and records what it was asked to wait for. */
const recordingSleep = (delays) => (ms) => (delays.push(ms), Promise.resolve())

test('a status is found wherever the client of the day put it', () => {
  assert.equal(statusOf(axiosError(503)), 503)
  assert.equal(statusOf(gotError(502)), 502)
  assert.equal(statusOf(tmdbError(429)), 429)
  assert.equal(statusOf(networkError('ECONNRESET')), undefined)
  assert.equal(statusOf(new TypeError('items is undefined')), undefined)
  assert.equal(statusOf(undefined), undefined)
})

test('the failures the APIs recover from on their own are transient', () => {
  // 503 is the one issue #80 is about; the rest fail the same way.
  ;[408, 425, 429, 500, 502, 503, 504].forEach((status) => {
    assert.equal(isTransient(axiosError(status)), true, `HTTP ${status}`)
    assert.equal(isTransient(gotError(status)), true, `HTTP ${status}`)
  })
  assert.equal(isTransient(tmdbError(429)), true)
  assert.equal(isTransient(networkError('ECONNRESET')), true)
  assert.equal(isTransient(networkError('EAI_AGAIN')), true)
})

test('an answer, or a mistake of ours, is not', () => {
  // Retrying these only makes the user wait for the same failure. A 401 in
  // particular means the key is wrong and will still be wrong in 200ms.
  ;[400, 401, 403, 404, 422].forEach((status) => {
    assert.equal(isTransient(axiosError(status)), false, `HTTP ${status}`)
  })
  assert.equal(isTransient(tmdbError(404)), false)
  assert.equal(isTransient(new TypeError('items is undefined')), false)
  assert.equal(isTransient('Something terrible happened'), false)
  assert.equal(isTransient(undefined), false)
})

test('backoff grows, and stops growing', () => {
  assert.equal(backoffMs(1), 200)
  assert.equal(backoffMs(2), 400)
  assert.equal(backoffMs(3), 800)
  assert.equal(backoffMs(20), MAX_DELAY_MS)
})

test('a call that works is made once and returned', async () => {
  let calls = 0

  const result = await retrying(async () => (calls++, 'ok'))

  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('a blip is retried, and the second answer is the one returned', async () => {
  const delays = []
  let calls = 0

  const result = await retrying(
    async () => {
      calls++
      if (calls === 1) throw axiosError(503)
      return 'ok'
    },
    { sleep: recordingSleep(delays) },
  )

  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.deepEqual(delays, [200])
})

test('an API that stays down gives up, and says how it failed', async () => {
  const delays = []
  let calls = 0

  await assert.rejects(
    retrying(
      async () => { calls++; throw axiosError(503) },
      { sleep: recordingSleep(delays) },
    ),
    /status code 503/,
  )

  assert.equal(calls, ATTEMPTS)
  assert.deepEqual(delays, [200, 400])
})

test('a permanent failure is not retried at all', async () => {
  const delays = []
  let calls = 0

  await assert.rejects(
    retrying(
      async () => { calls++; throw axiosError(404) },
      { sleep: recordingSleep(delays) },
    ),
    /status code 404/,
  )

  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

test('failures describe themselves rather than stringifying to {}', () => {
  // `JSON.stringify(new Error(...))` is `{}`, which is how one upstream
  // failure came to look exactly like every other one in the logs.
  assert.equal(
    describeFailure(axiosError(503)),
    'HTTP 503 Request failed with status code 503',
  )
  assert.equal(describeFailure(networkError('ECONNRESET')), 'ECONNRESET socket hang up')
  assert.equal(describeFailure('Something terrible happened'), 'Something terrible happened')
  assert.equal(describeFailure(undefined), 'undefined')
})
