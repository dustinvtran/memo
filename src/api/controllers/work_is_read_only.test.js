/**
 * @file The one rule the two-document design rests on, asserted rather than
 * observed: **a work is read-only from the user's side.**
 *
 * `docs/works_and_entries.md` is the reasoning. The short version is that a
 * work is the database's copy of what an API says, so a refresh may overwrite
 * the whole document without asking anybody, and what a person types lives on
 * their entry in `overrides` and is laid over the work when the row renders.
 *
 * Until now that was a convention held up by four separate pieces of code
 * happening to agree, and when a row broke it the symptom was **silence**: the
 * #290 title guard refuses to merge an API response whose title disagrees with
 * the stored one, so a work carrying a person's name is refused every night,
 * for ever, with no error and no report. #381 found 93 of them, some frozen
 * for years, which is what a convention nothing checks eventually costs.
 *
 * So each half of the rule gets a test here, driven through the real handlers
 * against the in-memory Mongo rather than by reading the source: a test that
 * greps for `updateOne` passes happily while a fifth code path writes a work
 * some other way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dependenciesInstalled = await (async () => {
  try {
    await import('neverthrow')
    await import('zod')
    await import('ts-pattern')
    await import('ramda')
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
// The same in-memory Mongo as entries.test.js, with one addition: every
// mutating call is recorded, so a test can ask what was written and to which
// collection rather than inspecting the store afterwards and inferring.

const store = {}

/** `{ collection, op }` for every write attempted, in order. */
const writes = []

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

const record = (name, op) => writes.push({ collection: name, op })

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () =>
      collectionOf(name).filter((doc) => matches(doc, pipeline[0].$match)),
  }),
  find: (filter, { limit } = {}) => ({
    toArray: async () => {
      const found = collectionOf(name).filter((doc) => matches(doc, filter))
      return limit ? found.slice(0, limit) : found
    },
  }),
  findOne: async (filter) =>
    collectionOf(name).find((doc) => matches(doc, filter)) ?? null,
  insertOne: async (doc) => (
    record(name, 'insertOne'), collectionOf(name).push(doc), { insertedId: doc._id }
  ),
  updateOne: async (filter, { $set }) => {
    record(name, 'updateOne')
    const doc = collectionOf(name).find((d) => matches(d, filter))
    if (doc) Object.assign(doc, $set)
    return { modifiedCount: doc ? 1 : 0 }
  },
  deleteOne: async (filter) => {
    record(name, 'deleteOne')
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: 1 }
  },
  deleteMany: async (filter) => {
    record(name, 'deleteMany')
    const before = collectionOf(name).length
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: before - store[name].length }
  },
})

const startSession = () => {
  const session = {
    withTransaction: async (work) => {
      const before = structuredClone(store)
      try {
        return await work(session)
      } catch (error) {
        for (const name of Object.keys(store)) delete store[name]
        Object.assign(store, before)
        throw error
      }
    },
    endSession: async () => {},
  }
  return session
}

class MongoClient {
  async connect() {}
  db() {
    return {
      databaseName: 'memo',
      collection,
      admin: () => ({ command: async () => ({ setName: 'a-replica-set' }) }),
    }
  }
  withSession(executor) {
    return executor(startSession())
  }
}

const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const entries = dependenciesInstalled ? await import('../routes/entries.js') : undefined
const works = dependenciesInstalled ? await import('../routes/works.js') : undefined

const call = async (route, method, url, { as, body } = {}) => {
  const response = await route.handler(
    {
      httpMethod: method,
      path: `/.netlify/functions/${url}`,
      headers: as ? { authorization: `Bearer ${await tokenFor(as)}` } : {},
      body: body === undefined ? null : JSON.stringify(body),
    },
    {}
  )
  return {
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

/** Every collection a work of any type lives in. */
const WORK_COLLECTIONS = ['films', 'tvShows', 'games', 'books']

/** The work these tests are about, as an API would have left it. */
const THE_WORK = {
  _id: 'w1',
  englishTranslatedTitle: 'Stalker',
  originalTitle: 'Сталкер',
  releaseYear: 1979,
  duration: 162,
  apiRefs: ['tmdb__1398'],
  genres: ['Science Fiction'],
  directors: ['Andrei Tarkovsky'],
}

const seed = () => {
  writes.length = 0
  for (const name of Object.keys(store)) delete store[name]
  store.users = [{ _id: 'u1', userId: 'u1', username: 'nil' }]
  store.films = [structuredClone(THE_WORK)]
  store.filmEntries = []
  store.filmReviews = []
  store.entryRevisions = []
}

/** What the form sends: the person's own name and year for this work. */
const form = (extra) => ({
  commonMetadata: null,
  workRef: 'w1',
  overrides: { englishTranslatedTitle: 'Stalker: Criterion cut', releaseYear: 1980 },
  status: 'Completed',
  score: 9,
  startedDate: 1700000000000,
  completedDate: 1700100000000,
  review: 'a note',
  ...extra,
})

const workWrites = () => writes.filter((w) => WORK_COLLECTIONS.includes(w.collection))

///////////////////////////////////////////////////////////////////////////////

/**
 * The half that matters most, because it is the one a new feature would break
 * without noticing: saving is where user text and a work are in the same
 * request, and the only correct number of writes to a work there is none.
 */
test('saving an entry writes to no work collection at all', options, async () => {
  seed()
  const created = await call(entries, 'POST', 'entries/films', { as: 'u1', body: form() })
  assert.equal(created.statusCode, 200)
  assert.deepEqual(workWrites(), [])

  const updated = await call(entries, 'PATCH', `entries/films/${store.filmEntries[0]._id}`, {
    as: 'u1',
    body: form({ score: 10 }),
  })
  assert.equal(updated.statusCode, 200)
  assert.deepEqual(workWrites(), [])
})

/**
 * The same thing stated as data rather than as call counts, so that a write
 * arriving through some path this fake does not record still fails.
 */
test('the work document is untouched by a save, field for field', options, async () => {
  seed()
  await call(entries, 'POST', 'entries/films', { as: 'u1', body: form() })
  assert.deepEqual(store.films, [THE_WORK])
})

/** What the person typed has to be somewhere, and the entry is where. */
test("the person's own title and year land on the entry, not the work", options, async () => {
  seed()
  await call(entries, 'POST', 'entries/films', { as: 'u1', body: form() })

  const [entry] = store.filmEntries
  assert.equal(entry.overrides.englishTranslatedTitle, 'Stalker: Criterion cut')
  assert.equal(entry.overrides.releaseYear, 1980)
  assert.equal(store.films[0].englishTranslatedTitle, 'Stalker')
  assert.equal(store.films[0].releaseYear, 1979)
})

/**
 * A work's identity, and the reason an override is safe: renaming a row on a
 * list must not be able to re-point it at a different film. Nothing on an
 * entry may reach `apiRefs`, including a field named like one.
 */
test('an override cannot reach the work it is linked to', options, async () => {
  seed()
  await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form({ overrides: { englishTranslatedTitle: 'mine', apiRefs: ['tmdb__999'] } }),
  })
  assert.deepEqual(store.films[0].apiRefs, ['tmdb__1398'])
  assert.deepEqual(workWrites(), [])
})

/**
 * `commonMetadata` is the work as the list handed it out, and the form sends
 * it back. It is read there and must not be written back: that shape is the
 * one way a client could post a work's fields at all.
 */
test('a work posted back inside commonMetadata is not written', options, async () => {
  seed()
  await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form({
      commonMetadata: { ...THE_WORK, englishTranslatedTitle: 'posted back', releaseYear: 2099 },
    }),
  })
  assert.deepEqual(store.films, [THE_WORK])
  assert.deepEqual(workWrites(), [])
})

/**
 * Deleting is a write path too, and it is the one where "tidy up the work as
 * well" is a tempting thing to add.
 */
test('deleting an entry leaves the work where it is', options, async () => {
  seed()
  await call(entries, 'POST', 'entries/films', { as: 'u1', body: form() })
  writes.length = 0
  const gone = await call(entries, 'DELETE', `entries/films/${store.filmEntries[0]._id}`, { as: 'u1' })
  assert.equal(gone.statusCode, 200)
  assert.deepEqual(workWrites(), [])
  assert.deepEqual(store.films, [THE_WORK])
})

/**
 * The route surface. `works.js` answers `search` and `retrieve` and nothing
 * else, which is what makes "no form can post a work" true rather than merely
 * true today — a handler that grew a write verb would fail here.
 */
test('the works route answers no verb that could write', options, async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await call(works, method, 'works/retrieve/films/1398')
    assert.equal(response.statusCode, 404, `${method} /works/retrieve should be 404`)
    const search = await call(works, method, 'works/search/films/stalker')
    assert.equal(search.statusCode, 404, `${method} /works/search should be 404`)
  }
})
