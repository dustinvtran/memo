/**
 * @file `GET /api/stats/:username` on both sides of the 48-hour cache, driven
 * through the real Netlify handler against an in-memory Mongo.
 *
 * The point of these is #145: the endpoint answered with `{ scores,
 * updatedDate }` when the stored tallies were fresh and `{ scores }` when it
 * had just recomputed them, so which shape a caller got depended on when
 * somebody last loaded that profile. So they assert the two answers against
 * each other rather than each against a literal — a shape that changes has to
 * change on both paths or fail here.
 *
 * The two at the end are #139: a name nobody has taken used to reach
 * `refreshStats` with the `{}` the db module then reported a miss as, read
 * `.data.userId` off it and throw — inside an `andThen` callback, where
 * neverthrow does not catch, so the handler returned a rejected promise and
 * Netlify answered 502 with an empty body. The route is public, so that was
 * one unauthenticated GET away. A miss is `null` now and `findOneByFieldOrFail_`
 * turns it into an err, but the endpoint is what has to answer 404, so the
 * test stays here.
 *
 * That needs the actual dependencies, so the file **skips itself** when they
 * aren't installed (which is how CI runs the suite). The same shape is pinned
 * without them on `toStats` in ../utils/score_tallies.test.js.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('neverthrow')
    require('zod')
    require('ts-pattern')
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
// A Mongo small enough to keep in a variable — the same one name.test.js
// keeps, plus the `$group` this route is built on.

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

/**
 * `[{ $match }, { $group }]`, which is the whole of `toScoreTallyPipeline`.
 * A missing field and an explicit `null` group together under one `_id: null`
 * here as they do in Mongo, because that is the `unrated` bucket.
 */
const runPipeline = (name, [{ $match: filter }, grouping]) => {
  const matched = collectionOf(name).filter((doc) => matches(doc, filter))
  if (!grouping) return matched

  const field = grouping.$group._id.replace('$', '')
  const counts = matched.reduce(
    (tally, doc) =>
      tally.set(doc[field] ?? null, (tally.get(doc[field] ?? null) ?? 0) + 1),
    new Map()
  )
  return [...counts].map(([_id, count]) => ({ _id, count }))
}

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () => runPipeline(name, pipeline),
  }),
  find: (filter) => ({
    toArray: async () => collectionOf(name).filter((doc) => matches(doc, filter)),
  }),
  findOne: async (filter) =>
    collectionOf(name).find((doc) => matches(doc, filter)) ?? null,
  insertOne: async (doc) => (collectionOf(name).push(doc), { insertedId: doc._id }),
  updateOne: async (filter, { $set }) => {
    const doc = collectionOf(name).find((d) => matches(d, filter))
    if (doc) Object.assign(doc, $set)
    return { modifiedCount: doc ? 1 : 0 }
  },
  deleteOne: async (filter) => {
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: 1 }
  },
})

class MongoClient {
  async connect() {}
  db() {
    return { databaseName: 'memo', collection }
  }
}

/* The in-memory Mongo goes in through the seam `db.js` leaves for it, rather
   than by intercepting `require('mongodb')`. ES modules have no `Module._load`,
   and that patch was the only thing keeping this tree on CommonJS — see
   `docs/module_system.md`. The tokens are real for the same reason. */
const { useClient } = dependenciesInstalled ? require('../utils/db/db') : {}
const { tokenFor } = dependenciesInstalled ? require('./test_tokens') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const stats = dependenciesInstalled ? require('../routes/stats') : undefined

///////////////////////////////////////////////////////////////////////////////

const getStats = async (username) => {
  const response = await stats.handler(
    {
      httpMethod: 'GET',
      path: `/.netlify/functions/stats/${username}`,
      headers: {},
      body: null,
    },
    {}
  )
  return {
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

const MS_IN_DAY = 86400000

const emptyTally = () => ({
  1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, unrated: 0,
})

/** A user whose stored tallies are as old as the caller says. */
const seed = ({ statsAge, extraStoredFields = {} } = {}) => {
  store.users = [
    {
      _id: 'a1',
      userId: 'u1',
      username: 'reader',
      ...(statsAge === undefined
        ? {}
        : {
            stats: {
              scores: {
                games: { ...emptyTally(), 9: 1 },
                tv: emptyTally(),
                films: emptyTally(),
                books: emptyTally(),
              },
              updatedDate: Date.now() - statsAge,
              ...extraStoredFields,
            },
          }),
    },
  ]

  store.gameEntries = [
    { _id: 'g1', userId: 'u1', status: 'Completed', score: 8 },
    { _id: 'g2', userId: 'u1', status: 'Completed', score: 8 },
    { _id: 'g3', userId: 'u1', status: 'Planned', score: null },
  ]
  store.tvShowEntries = [{ _id: 't1', userId: 'u1', status: 'Watching' }]
  store.filmEntries = []
  store.bookEntries = [{ _id: 'b1', userId: 'u1', status: 'Read', score: 3 }]
}

///////////////////////////////////////////////////////////////////////////////

test('a fresh cache and a recompute answer with the same keys', options, async () => {
  // The bug, stated as directly as it can be: two requests for the same
  // profile, one on each side of the 48-hour line, used to come back with a
  // different set of fields.
  seed({ statsAge: MS_IN_DAY })
  const { body: cached } = await getStats('reader')

  seed({ statsAge: 3 * MS_IN_DAY })
  const { body: recomputed } = await getStats('reader')

  assert.deepEqual(Object.keys(cached).sort(), Object.keys(recomputed).sort())
  assert.deepEqual(Object.keys(cached).sort(), ['scores', 'updatedDate'])
})

test('a profile with no stats yet answers with that same shape', options, async () => {
  seed({})
  const { statusCode, body } = await getStats('reader')

  assert.equal(statusCode, 200)
  assert.deepEqual(Object.keys(body).sort(), ['scores', 'updatedDate'])
  assert.equal(typeof body.updatedDate, 'number')
})

test('the fresh tallies are answered with, not recomputed ones', options, async () => {
  seed({ statsAge: MS_IN_DAY })
  const stored = store.users[0].stats

  const { body } = await getStats('reader')

  assert.equal(body.updatedDate, stored.updatedDate)
  // The stored 9 rather than the 8s the entries would count to.
  assert.equal(body.scores.games['9'], 1)
  assert.equal(body.scores.games['8'], 0)
})

test('the recomputed answer carries the timestamp that was stored', options, async () => {
  // Not a second `Date.now()`: the numbers a caller is given and the moment
  // they are dated to have to be the same moment.
  seed({ statsAge: 3 * MS_IN_DAY })

  const { body } = await getStats('reader')

  assert.equal(body.updatedDate, store.users[0].stats.updatedDate)
  assert.deepEqual(body.scores, store.users[0].stats.scores)
})

test('the recompute counts the entries and skips the Planned one', options, async () => {
  seed({ statsAge: 3 * MS_IN_DAY })

  const { body } = await getStats('reader')

  assert.equal(body.scores.games['8'], 2)
  assert.equal(body.scores.games.unrated, 0)
  assert.equal(body.scores.tv.unrated, 1)
  assert.equal(body.scores.books['3'], 1)
  assert.deepEqual(body.scores.films, emptyTally())
})

test('a field stored beside the two is not published with them', options, async () => {
  // The cache-hit path handed back the stored object as it found it, so
  // anything ever added under `users.stats` went out with it. See #105.
  seed({ statsAge: MS_IN_DAY, extraStoredFields: { internalNote: 'not yours' } })

  const { body } = await getStats('reader')

  assert.deepEqual(Object.keys(body).sort(), ['scores', 'updatedDate'])
  assert.equal('internalNote' in body, false)
})

/**
 * #139. `findOneByField_` used to report a miss as `{}`, which `refreshStats`
 * read `.data.userId` off. The throw happened inside an `andThen` callback,
 * where neverthrow does not catch it, so the handler returned a rejected
 * promise and the caller got a 502 with no body.
 */
test('a username nobody has taken is a 404 and not a crash', options, async () => {
  seed({ statsAge: MS_IN_DAY })

  const { statusCode, body } = await getStats('nosuchuser')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
})

test('a username nobody has taken counts nothing and stores nothing', options, async () => {
  seed({})
  const before = JSON.stringify(store.users)

  await getStats('nosuchuser')

  assert.equal(JSON.stringify(store.users), before)
})
