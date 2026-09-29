/**
 * @file `GET /api/reviews/:type/:entryRef`, driven through the real Netlify
 * handler against an in-memory Mongo.
 *
 * The route used to answer `200 {}` for a note nobody wrote, for an id that
 * names no entry and for a string that could not be an id at all, so a caller
 * could not tell the three apart. #477. That needs the actual dependencies, so
 * the file **skips itself** when they aren't installed (which is how CI runs
 * the suite).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('neverthrow')
    await import('ts-pattern')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://in-memory'

///////////////////////////////////////////////////////////////////////////////
// A Mongo of plain arrays. `findOne` on equality is all this route asks of it.

const store = {}

let readsFail = false

const collection = (name) => ({
  findOne: async (filter) => {
    if (readsFail) throw new Error('read failed')
    return (store[name] ?? []).find((doc) =>
      Object.entries(filter).every(([field, value]) => doc[field] === value)
    ) ?? null
  },
})

class MongoClient {
  async connect() {}
  db() {
    return { databaseName: 'memo', collection }
  }
}

const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const reviews = dependenciesInstalled ? await import('../routes/reviews.js') : undefined

///////////////////////////////////////////////////////////////////////////////

const call = async (url) => {
  const response = await reviews.handler(
    { httpMethod: 'GET', path: `/.netlify/functions/reviews/${url}`, headers: {}, body: null },
    {}
  )
  return {
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

const UUID = '0f8b2c3e-6a1d-4e2f-9b7a-1c2d3e4f5a6b'
const FAUNA = '345678901234567890'
const NOTELESS = 'b1e1a5b2-0000-4000-8000-000000000000'

const seed = () => {
  store.filmEntries = [{ _id: UUID }, { _id: FAUNA }, { _id: NOTELESS }]
  store.filmReviews = [
    { _id: 'r1', entryRef: UUID, text: 'A note.' },
    { _id: 'r2', entryRef: FAUNA, text: 'An older note.' },
  ]
}

///////////////////////////////////////////////////////////////////////////////

test('a note is answered in its `data` wrapper', options, async () => {
  seed()

  const { statusCode, body } = await call(`films/${UUID}`)

  assert.equal(statusCode, 200)
  assert.equal(body.data.text, 'A note.')
})

test('an entry from the Fauna era is an id like any other', options, async () => {
  seed()

  const { statusCode, body } = await call(`films/${FAUNA}`)

  assert.equal(statusCode, 200)
  assert.equal(body.data.text, 'An older note.')
})

test('an entry with no note is still a 200 with nothing in it', options, async () => {
  // What the note panel turns into its placeholder — and now the only thing
  // that answers this way.
  seed()

  const { statusCode, body } = await call(`films/${NOTELESS}`)

  assert.equal(statusCode, 200)
  assert.deepEqual(body, {})
})

test('an id that names no entry is a 404', options, async () => {
  seed()

  const { statusCode, body } = await call('films/not-an-id')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
})

test('a review whose entry is gone is a 404, not the orphaned note', options, async () => {
  // #117's backlog: a review document left behind by a deleted entry.
  seed()
  store.filmReviews.push({ _id: 'r3', entryRef: 'gone', text: 'Unreachable.' })

  const { statusCode } = await call('films/gone')

  assert.equal(statusCode, 404)
})

test('the entry is looked for in the collection the type names', options, async () => {
  seed()

  const { statusCode } = await call(`games/${UUID}`)

  assert.equal(statusCode, 404)
})

for (const [what, segment] of Object.entries({
  punctuation: 'nil.moe',
  'an encoded operator': encodeURIComponent('{"$ne":null}'),
  'a space': encodeURIComponent('two words'),
  'more characters than any id': 'a'.repeat(65),
})) {
  test(`an id with ${what} in it is a 400`, options, async () => {
    seed()

    const { statusCode, body } = await call(`films/${segment}`)

    assert.equal(statusCode, 400)
    assert.equal(body.error, 'RequestError')
  })
}

test('a type that is not one is still a 404', options, async () => {
  seed()

  const { statusCode } = await call(`nonsense/${UUID}`)

  assert.equal(statusCode, 404)
})

test('a database that does not answer is a 500, not a 404', options, async () => {
  seed()
  readsFail = true

  try {
    const { statusCode, body } = await call(`films/${UUID}`)

    assert.equal(statusCode, 500)
    assert.equal(body.error, 'DBError')
  } finally {
    readsFail = false
  }
})
