/**
 * @file What an error response says, and what it refuses to say.
 *
 * Reads are unauthenticated, so a stranger can make any of these happen at
 * will and read what comes back. The rule these hold to: the class of the
 * failure and anything the caller can act on may go out; the driver's account
 * of itself — hosts, topology, credentials, stack — may not, and goes to the
 * function log instead. See #105.
 *
 * `responses.js` pulls in ts-pattern and neverthrow, so this file **skips
 * itself** when the dependencies aren't installed (which is how CI runs the
 * suite), the same way name.test.js and revisions.test.js do.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('neverthrow')
    require('ts-pattern')
    require('ramda')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

const responses = dependenciesInstalled ? require('./responses') : undefined
const errors = dependenciesInstalled ? require('./errors') : undefined
const intoSafeValues = dependenciesInstalled ? require('./db/into_safe_values') : undefined

///////////////////////////////////////////////////////////////////////////////

/**
 * A Mongo failure of the kind that actually reaches this code: the driver
 * names every host it tried and dumps the topology it gave up on.
 */
const HOSTS = 'memo-shard-00-01.9x8y7.mongodb.net:27017'
const topologyError = () =>
  Object.assign(
    new Error(
      `Server selection timed out after 30000 ms, Topology description: ` +
      `{ servers: { '${HOSTS}' => ServerDescription { error: MongoNetworkError } } }`
    ),
    { name: 'MongoServerSelectionError' },
  )

/** Runs `f` with console.error captured rather than printed. */
const capturingLogs = async (f) => {
  const lines = []
  const realError = console.error
  console.error = (line) => lines.push(String(line))
  try {
    return [await f(), lines]
  } finally {
    console.error = realError
  }
}

const bodyOf = (response) => JSON.parse(response.body)

///////////////////////////////////////////////////////////////////////////////

test('a driver failure is not what the caller is handed', options, async () => {
  const [response] = await capturingLogs(() =>
    responses.fromError(errors.db(topologyError()))
  )

  assert.equal(response.statusCode, 500)
  assert.equal(response.body.includes(HOSTS), false)
  assert.equal(response.body.includes('Topology'), false)
  assert.equal(response.body.includes('MongoServerSelectionError'), false)
  assert.deepEqual(bodyOf(response), {
    error: 'DBError',
    message: responses.STOCK_MESSAGES.DBError,
  })
})

test('the same failure is written to the log in full', options, async () => {
  const [, lines] = await capturingLogs(() =>
    responses.fromError(errors.db(topologyError()))
  )

  assert.equal(lines.length, 1)
  assert.equal(lines[0].includes(HOSTS), true)
  assert.equal(lines[0].startsWith('DBError:'), true)
})

test('the careless single-argument call publishes nothing', options, async () => {
  // `.mapErr(errors.internal)` and `errors.db(err)` are how a caught exception
  // gets into an error, so the first parameter is the one that stays inside.
  const [response] = await capturingLogs(() =>
    responses.fromError(errors.internal(topologyError()))
  )

  assert.equal(response.body.includes(HOSTS), false)
  assert.equal(bodyOf(response).message, responses.STOCK_MESSAGES.InternalError)
})

test('a message meant for the caller is sent as written', options, async () => {
  const [response] = await capturingLogs(() =>
    responses.fromError(errors.notFound(topologyError(), 'no such game'))
  )

  assert.equal(response.statusCode, 404)
  assert.deepEqual(bodyOf(response), { error: 'NotFound', message: 'no such game' })
  assert.equal(response.body.includes(HOSTS), false)
})

test('an error with nothing to log is not logged', options, async () => {
  const [response, lines] = await capturingLogs(() =>
    responses.fromError(errors.notFound(undefined, 'no such tv show'))
  )

  assert.deepEqual(lines, [])
  assert.equal(bodyOf(response).message, 'no such tv show')
})

test('each class of error keeps its status', options, async () => {
  const statusOf = async (error) =>
    (await capturingLogs(() => responses.fromError(error)))[0].statusCode

  assert.equal(await statusOf(errors.db()), 500)
  assert.equal(await statusOf(errors.req()), 400)
  assert.equal(await statusOf(errors.unauthorized()), 401)
  assert.equal(await statusOf(errors.notFound()), 404)
  assert.equal(await statusOf(errors.internal()), 500)
  assert.equal(await statusOf({ error: 'SomethingNew' }), 500)
})

test('an unrecognised error still says something', options, async () => {
  const [response] = await capturingLogs(() =>
    responses.fromError({ error: 'SomethingNew' })
  )

  assert.equal(bodyOf(response).message, responses.STOCK_MESSAGES.InternalError)
})

test('every response says how to read its body', options, () => {
  const contentType = (response) => response.headers['content-type']

  assert.equal(contentType(responses.ok({ username: 'nil' })), responses.JSON_CONTENT_TYPE)
  assert.equal(contentType(responses.notFound()), responses.JSON_CONTENT_TYPE)
  assert.equal(contentType(responses.payloadTooLarge({ error: 'too big' })), responses.JSON_CONTENT_TYPE)
})

test('a body that cannot be stringified is a 500 and not a crash', options, () => {
  const circular = {}
  circular.self = circular

  const response = responses.ok(circular)

  assert.equal(response.statusCode, 500)
  assert.equal(response.body, undefined)
})

test('a rejected query answers without quoting the driver', options, async () => {
  const [response, lines] = await capturingLogs(() =>
    intoSafeValues.toResponse(Promise.reject(topologyError()))
  )

  assert.equal(response.statusCode, 500)
  assert.equal(response.body.includes(HOSTS), false)
  assert.equal(lines.some((line) => line.includes(HOSTS)), true)
})

test('a query rejecting with a 4xx keeps its status', options, async () => {
  const notFound = Object.assign(new Error('nothing there'), { name: 'NotFound' })

  const [response] = await capturingLogs(() =>
    intoSafeValues.toResponse(Promise.reject(notFound))
  )

  assert.equal(response.statusCode, 404)
})
