/**
 * @file The two 404s of `GET /api/export`, driven through the real Netlify
 * handler against an in-memory Mongo.
 *
 * #280. Both were written `errors.notFound(<the sentence>)`, and `errors.js`
 * takes `(detail, message)` — so both sentences went to the function log and
 * the caller got `STOCK_MESSAGES.NotFound`, "not found". These assert the
 * body and not only the status, because the status was never the part that
 * was wrong: a test on `statusCode === 404` passed the whole time.
 *
 * The console assertions are the other half of the same bug. `no such user:
 * ${username}` was a log line written out of an unauthenticated route's own
 * url segment, one per request, carrying whatever the caller sent — the write
 * `findOneByFieldOrFail_` refuses to make, and for this reason. So these
 * check that nothing is logged at all rather than that the right thing is
 * sent.
 *
 * The 200 at the end is the control for the second: a db seam that found
 * nobody would answer 404 for a real user too, and the test above it would
 * pass on that just as happily.
 *
 * That needs the actual dependencies, so the file **skips itself** when they
 * aren't installed — which is how the `test` job runs the suite. The `build`
 * job installs them and asserts nothing skips.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('neverthrow')
    await import('zod')
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
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

///////////////////////////////////////////////////////////////////////////////
// A Mongo small enough to keep in a variable — the same one stats.test.js
// keeps, with the `$sort`, `$lookup` and `$project` this route's pipeline adds
// to the `$match` that one needed.

const store = {}

const matchesValue = (value, wanted) =>
  wanted && typeof wanted === 'object' && !Array.isArray(wanted)
    ? '$ne' in wanted
      ? value !== wanted.$ne
      : wanted.$in.includes(value)
    : value === wanted

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([field, wanted]) =>
    matchesValue(doc[field], wanted)
  )

const collectionOf = (name) => (store[name] = store[name] ?? [])

/** `{ updatedDate: -1, _id: 1 }`, in the order the keys are written. */
const bySortSpec = (spec) => (a, b) =>
  Object.entries(spec).reduce(
    (order, [field, direction]) =>
      order !== 0 ? order
        : a[field] === b[field] ? 0
        : (a[field] < b[field] ? -1 : 1) * direction,
    0
  )

/** Exclusion only, which is all `toUserEntriesPipeline` asks for. */
const withoutFields = (doc, projection) =>
  Object.fromEntries(
    Object.entries(doc).filter(([field]) => !(field in projection))
  )

const applyStage = (rows, stage) => {
  if (stage.$match) return rows.filter((doc) => matches(doc, stage.$match))
  if (stage.$sort) return [...rows].sort(bySortSpec(stage.$sort))
  if (stage.$limit) return rows.slice(0, stage.$limit)
  if (stage.$project) return rows.map((doc) => withoutFields(doc, stage.$project))
  if (stage.$lookup) {
    const { from, localField, foreignField, as } = stage.$lookup
    return rows.map((doc) => ({
      ...doc,
      [as]: collectionOf(from).filter(
        (joined) => joined[foreignField] === doc[localField]
      ),
    }))
  }
  // Louder than quietly passing the rows through: a stage this doesn't know
  // is a pipeline it is no longer standing in for.
  throw new Error(`the fake Mongo has no ${Object.keys(stage).join(', ')}`)
}

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () => pipeline.reduce(applyStage, collectionOf(name)),
  }),
  find: (filter) => ({
    toArray: async () => collectionOf(name).filter((doc) => matches(doc, filter)),
  }),
  findOne: async (filter) =>
    collectionOf(name).find((doc) => matches(doc, filter)) ?? null,
})

class MongoClient {
  async connect() {}
  db() {
    return { databaseName: 'memo', collection }
  }
}

/* Through the seam `db.js` leaves rather than by intercepting
   `require('mongodb')`; see the same note in stats.test.js and
   docs/module_system.md. */
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const exportRoute = dependenciesInstalled ? await import('../routes/export.js') : undefined

///////////////////////////////////////////////////////////////////////////////

/**
 * The handler, plus everything it wrote to the log while it ran. Both 404s
 * below are about which of the two a sentence came out of.
 */
const getExport = async (path) => {
  const logged = []
  const realError = console.error
  console.error = (...args) => logged.push(args.join(' '))

  try {
    const response = await exportRoute.handler(
      {
        httpMethod: 'GET',
        path: `/.netlify/functions/export${path}`,
        rawUrl: `https://nil.moe/api/export${path}`,
        headers: {},
        body: null,
      },
      {}
    )
    return {
      statusCode: response.statusCode,
      body: response.body ? JSON.parse(response.body) : undefined,
      logged,
    }
  } finally {
    console.error = realError
  }
}

const seed = () => {
  store.users = [{ _id: 'a1', userId: 'u1', username: 'reader' }]
  store.filmEntries = [
    {
      _id: 'e1',
      userId: 'u1',
      workRef: 'w1',
      status: 'Watched',
      score: 8,
      updatedDate: 1700000000000,
    },
  ]
  store.films = [
    { _id: 'w1', entryType: 'Film', englishTranslatedTitle: 'A Film', releaseYear: 2001 },
  ]
  store.filmReviews = []
  store.tvShowEntries = []
  store.tvShows = []
  store.tvShowReviews = []
  store.gameEntries = []
  store.games = []
  store.gameReviews = []
  store.bookEntries = []
  store.books = []
  store.bookReviews = []
}

///////////////////////////////////////////////////////////////////////////////

/**
 * The four types spelled out rather than joined from `LIST_TYPES`. Derived
 * from the same list the controller interpolates, this would agree with the
 * controller instead of checking it — and what it is checking is that the
 * sentence reaches the caller at all.
 */
const TYPES_SENTENCE = 'no such list type; try one of films, tv, games, books'

test('an unknown list type is told which types would have worked', options, async () => {
  seed()

  const { statusCode, body } = await getExport('/nosuchtype/reader')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
  assert.equal(body.message, TYPES_SENTENCE)
})

test('an unknown username is told which name was not found', options, async () => {
  seed()

  const { statusCode, body } = await getExport('/nobody-has-this-name')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
  assert.equal(body.message, 'no such user: nobody-has-this-name')
})

test('neither 404 writes the caller a line in the function log', options, async () => {
  // Why both carry no `detail`. The name is a url segment of an
  // unauthenticated GET, so a `detail` there is one log line per request with
  // whatever a stranger sent in it — the write `findOneByFieldOrFail_`
  // refuses to make. The type sentence has no `detail` worth having either:
  // there is no exception here, only a url that named nothing.
  seed()

  const type = await getExport('/nosuchtype/reader')
  const user = await getExport('/whatever-a-stranger-typed')

  assert.deepEqual(type.logged, [])
  assert.deepEqual(user.logged, [])
})

test('a real user still gets their list, so the 404 above means something', options, async () => {
  // Without this, a db seam that found nobody would answer 404 for every name
  // and the "no such user" test would pass on a route that was wholly broken.
  seed()

  const { statusCode, body, logged } = await getExport('/films/reader')

  assert.equal(statusCode, 200)
  assert.equal(body.user, 'reader')
  assert.equal(body.lists.length, 1)
  assert.equal(body.lists[0].type, 'films')
  assert.equal(body.lists[0].count, 1)
  assert.equal(body.lists[0].entries[0].title, 'A Film')
  assert.deepEqual(logged, [])
})
