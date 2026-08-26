/**
 * @file What saving an entry writes when one of the writes refuses, and what
 * reading a list answers when the read refuses or the name is nobody's, driven
 * through the real Netlify handler against an in-memory Mongo.
 *
 * The fake here answers `hello` as a replica set, so `db.withTransaction`
 * opens a real transaction and the fake rolls the store back when the
 * callback throws. revisions.test.js's fake has no `admin` command at all, so
 * `withTransaction` falls back to plain writes there — between the two files
 * both halves of it are exercised.
 *
 * Needs the dependencies (zod parses what goes in), so it **skips itself**
 * when they aren't installed, which is how CI runs the suite.
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
/* The jose below takes every token at its word, but `getUserId` asks for the
   signing key before it gets there, and a key of no bytes is refused now. */
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

///////////////////////////////////////////////////////////////////////////////
// A Mongo small enough to keep in a variable, with a transaction that is a
// copy of the whole thing taken on the way in and put back on the way out.

const store = {}

/** The one write that is going to refuse, as `{ collection, op }`. */
let broken = null

/** Only the operators the queries in this module actually use. */
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

const project = (doc, projection) => {
  if (!projection) return doc

  const isInclusion = Object.entries(projection).some(
    ([field, on]) => field !== '_id' && on
  )

  return Object.fromEntries(
    Object.entries(doc).filter(([field]) =>
      field === '_id'
        ? projection._id !== 0
        : isInclusion
          ? Boolean(projection[field])
          : projection[field] !== 0
    )
  )
}

const collectionOf = (name) => (store[name] = store[name] ?? [])

const refuseIfBroken = (name, op) => {
  if (broken?.collection === name && broken?.op === op) {
    throw new Error(`the database refused to ${op} on ${name}`)
  }
}

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () => (
      refuseIfBroken(name, 'aggregate'),
      collectionOf(name).filter((doc) => matches(doc, pipeline[0].$match))
    ),
  }),
  find: (filter, { projection, limit } = {}) => ({
    toArray: async () => {
      const found = collectionOf(name).filter((doc) => matches(doc, filter))
      return (limit ? found.slice(0, limit) : found).map((doc) =>
        project(doc, projection)
      )
    },
  }),
  findOne: async (filter, { projection } = {}) => {
    const doc = collectionOf(name).find((doc) => matches(doc, filter))
    return doc ? project(doc, projection) : null
  },
  insertOne: async (doc) => (
    refuseIfBroken(name, 'insertOne'),
    collectionOf(name).push(doc),
    { insertedId: doc._id }
  ),
  updateOne: async (filter, { $set }) => {
    refuseIfBroken(name, 'updateOne')
    const doc = collectionOf(name).find((d) => matches(d, filter))
    if (doc) Object.assign(doc, $set)
    return { modifiedCount: doc ? 1 : 0 }
  },
  deleteOne: async (filter) => {
    refuseIfBroken(name, 'deleteOne')
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: 1 }
  },
  deleteMany: async (filter) => {
    refuseIfBroken(name, 'deleteMany')
    const before = collectionOf(name).length
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: before - store[name].length }
  },
})

// The driver hands the callback the session and hands the caller back what
// the callback returned; `db.withTransaction` relies on both.
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

/* The in-memory Mongo goes in through the seam `db.js` leaves for it, rather
   than by intercepting `require('mongodb')`. ES modules have no `Module._load`,
   and that patch was the only thing keeping this tree on CommonJS — see
   `docs/module_system.md`. The tokens are real for the same reason. */
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const entries = dependenciesInstalled ? await import('../routes/entries.js') : undefined
const revisions = dependenciesInstalled ? await import('../routes/revisions.js') : undefined

///////////////////////////////////////////////////////////////////////////////

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

const seed = () => {
  broken = null
  store.users = [{ _id: 'u1', userId: 'u1', username: 'nil' }]
  store.filmEntries = []
  store.filmReviews = []
  store.entryRevisions = []
}

const seedSavedEntry = () => {
  seed()
  store.filmEntries = [
    {
      _id: 'e1',
      userId: 'u1',
      status: 'InProgress',
      score: 7,
      workRef: 'w1',
      startedDate: 1700000000000,
      updatedDate: 1700000000000,
    },
  ]
  store.filmReviews = [{ _id: 'r1', entryRef: 'e1', text: 'the note as it was' }]
}

/** What the entry form sends when the user saves. */
const form = (extra) => ({
  commonMetadata: null,
  workRef: 'w1',
  overrides: { englishTranslatedTitle: 'Stalker', genres: null },
  status: 'Completed',
  score: 9,
  startedDate: 1700000000000,
  completedDate: 1700100000000,
  review: 'the note as it was rewritten',
  ...extra,
})

///////////////////////////////////////////////////////////////////////////////

test('creating an entry answers with the entry, not with its note', options, async () => {
  seed()

  const { statusCode, body } = await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form({ review: 'a first note' }),
  })

  assert.equal(statusCode, 200)
  assert.equal(store.filmEntries.length, 1)

  // The id of what was just created, which is the thing the caller cannot
  // work out for itself and had no way to read before. It is `_id`, the
  // document's own field, rather than a `ref.id` copied beside it.
  assert.equal(body._id, store.filmEntries[0]._id)
  assert.equal(body.status, 'Completed')
  assert.equal(body.score, 9)
  assert.equal(body.userId, 'u1')
  assert.equal('data' in body, false)
  assert.equal('ref' in body, false)

  // The note is written beside it rather than returned in its place.
  assert.equal(store.filmReviews[0].text, 'a first note')
  assert.equal(body.text, undefined)
  assert.equal(body.entryRef, undefined)
})

test('an entry saved without a note is still created', options, async () => {
  seed()

  // The form always sends the field, so this is not reachable from the site —
  // but `reviewParser` has `text: z.string()`, so `text: undefined` failed the
  // review write, and a failed write inside the transaction took the entry
  // with it: a 400 that created nothing. #213.
  const { review, ...withoutReview } = form()
  const { statusCode, body } = await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: withoutReview,
  })

  assert.equal(statusCode, 200)
  assert.equal(store.filmEntries.length, 1)
  assert.equal(store.filmEntries[0].status, 'Completed')
  assert.equal(body._id, store.filmEntries[0]._id)

  // No note was asked for, so none was written — rather than an empty one
  // standing in for the note the user did not leave.
  assert.deepEqual(store.filmReviews, [])
})

test('an empty note is a note, and is written', options, async () => {
  seed()

  await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form({ review: '' }),
  })

  assert.equal(store.filmReviews.length, 1)
  assert.equal(store.filmReviews[0].text, '')
})

test('an entry the parser refuses is a 400 and writes neither half', options, async () => {
  seed()

  const { statusCode, body } = await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form({ status: 'Abandoned' }),
  })

  assert.equal(statusCode, 400)
  assert.equal(body.error, 'RequestError')
  assert.deepEqual(store.filmEntries, [])
  assert.deepEqual(store.filmReviews, [])
})

/**
 * `updateEntry_` read the owner off the entry without checking there was one,
 * so a PATCH naming an id that isn't there threw on the miss the db module
 * reported — a rejected promise out of the handler, and a 502. The revisions
 * routes have always answered 401 here rather than 404, so that they cannot
 * be used to probe for ids; this now agrees with them.
 */
test('a save naming an entry that is not there is a 401, not a crash', options, async () => {
  seedSavedEntry()

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/nosuchentry', {
    as: 'u1',
    body: form(),
  })

  assert.equal(statusCode, 401)
  assert.equal(store.filmEntries.length, 1)
  assert.equal(store.filmEntries[0].status, 'InProgress')
})

test('an entry whose note will not write is not left behind', options, async () => {
  seed()
  broken = { collection: 'filmReviews', op: 'insertOne' }

  const { statusCode } = await call(entries, 'POST', 'entries/films', {
    as: 'u1',
    body: form(),
  })

  assert.equal(statusCode, 500)
  assert.deepEqual(store.filmEntries, [])
  assert.deepEqual(store.filmReviews, [])
})

test('a save whose note will not write leaves the entry as it was', options, async () => {
  seedSavedEntry()
  broken = { collection: 'filmReviews', op: 'updateOne' }

  const { statusCode, body } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form(),
  })

  assert.equal(statusCode, 500)
  assert.equal(store.filmEntries[0].status, 'InProgress')
  assert.equal(store.filmEntries[0].score, 7)
  assert.equal(store.filmEntries[0].updatedDate, 1700000000000)
  assert.equal(store.filmReviews[0].text, 'the note as it was')

  // A failed write inside a transaction leaves through `fromError` like every
  // other one, so what the driver said about it stays in the log. #105.
  assert.deepEqual(body, { error: 'DBError', message: 'the database did not answer' })
})

test('a save whose entry will not write leaves the note as it was', options, async () => {
  seedSavedEntry()
  broken = { collection: 'filmEntries', op: 'updateOne' }

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form(),
  })

  assert.equal(statusCode, 500)
  assert.equal(store.filmEntries[0].status, 'InProgress')
  assert.equal(store.filmReviews[0].text, 'the note as it was')
})

test('a save that did not happen keeps the draft it would have discarded', options, async () => {
  seedSavedEntry()
  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: form({ review: 'still being written' }),
  })
  broken = { collection: 'filmReviews', op: 'updateOne' }

  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: form() })

  broken = null
  const { body } = await call(revisions, 'GET', 'revisions/films/e1/draft', {
    as: 'u1',
  })
  assert.equal(body.draft.snapshot.review, 'still being written')
})

test('a save that goes through writes both halves and clears the draft', options, async () => {
  seedSavedEntry()
  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: form(),
  })

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form(),
  })

  assert.equal(statusCode, 200)
  assert.equal(store.filmEntries[0].status, 'Completed')
  assert.equal(store.filmEntries[0].score, 9)
  assert.equal(store.filmReviews[0].text, 'the note as it was rewritten')

  const drafts = store.entryRevisions.filter(({ kind }) => kind === 'draft')
  assert.deepEqual(drafts, [])

  // History is written outside the transaction, and a save that lands still
  // records the version it replaced.
  const history = store.entryRevisions.filter(({ kind }) => kind === 'revision')
  assert.equal(history.length, 1)
  assert.equal(history[0].snapshot.review, 'the note as it was')
})

///////////////////////////////////////////////////////////////////////////////
// What a PATCH is allowed to put in the document. `_updateOneByRef` writes
// what it is handed and parses nothing, so before #171 the request body was
// the update. These drive the real handler and assert on the store, because
// the whole question is what ended up in it.

test('a save cannot hand the entry to another user', options, async () => {
  seedSavedEntry()

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form({ userId: 'u2' }),
  })

  // The save itself is legitimate — u1 owns this entry — so it goes through.
  // The one field it may not touch is the one every ownership check reads.
  assert.equal(statusCode, 200)
  assert.equal(store.filmEntries[0].userId, 'u1')
  assert.equal(store.filmEntries[0].status, 'Completed')
})

test('the note is stored in the reviews collection and not on the entry', options, async () => {
  seedSavedEntry()

  await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form({ review: 'a note long enough to be worth not storing twice' }),
  })

  assert.equal(
    store.filmReviews[0].text,
    'a note long enough to be worth not storing twice'
  )
  assert.equal(store.filmEntries[0].review, undefined)
})

test('commonMetadata sent by the form is not written to the entry', options, async () => {
  seedSavedEntry()

  // `form()` still sends it, which is the point: an older bundle is still a
  // client, so the server has to drop this rather than trust the form to stop.
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: form() })

  assert.ok(!('commonMetadata' in store.filmEntries[0]))
})

test('a field nobody defined is dropped rather than stored', options, async () => {
  seedSavedEntry()

  await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form({ somethingInvented: 'x'.repeat(1000) }),
  })

  assert.ok(!('somethingInvented' in store.filmEntries[0]))
})

test('a field of the wrong type is a 400, and nothing is written', options, async () => {
  seedSavedEntry()

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: form({ score: 'nine' }),
  })

  assert.equal(statusCode, 400)
  assert.equal(store.filmEntries[0].status, 'InProgress')
  assert.equal(store.filmEntries[0].score, 7)
  assert.equal(store.filmReviews[0].text, 'the note as it was')
})

test('an ownership check still runs before any of this', options, async () => {
  seedSavedEntry()

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u2',
    body: form(),
  })

  assert.equal(statusCode, 401)
  assert.equal(store.filmEntries[0].status, 'InProgress')
})

///////////////////////////////////////////////////////////////////////////////
// GET /api/entries/:type/:username, which is public and unauthenticated — so
// every answer below is one request away from a stranger.

test('a list read answers with the entries', options, async () => {
  seedSavedEntry()

  const { statusCode, body } = await call(entries, 'GET', 'entries/films/nil')

  assert.equal(statusCode, 200)
  assert.equal(body.length, 1)
  assert.equal(body[0].dbRef, 'e1')
})

test('a list read the database refuses is a 500, and says nothing more', options, async () => {
  seedSavedEntry()
  broken = { collection: 'filmEntries', op: 'aggregate' }

  const { statusCode, body } = await call(entries, 'GET', 'entries/films/nil')

  // This answered `200` with the error itself as the body, `detail` and all —
  // and `detail` is the driver's account of the failure, which names every
  // host it tried. `fromError` logs that and tells the caller the class of
  // failure and not one word more. #250, #105.
  assert.equal(statusCode, 500)
  assert.equal('detail' in body, false)
  assert.deepEqual(body, { error: 'DBError', message: 'the database did not answer' })
})

test('a username nobody has taken is a 404, not an empty list', options, async () => {
  seedSavedEntry()

  const { statusCode, body } = await call(entries, 'GET', 'entries/films/nobodyhasthisname')

  // `200 []` before this — the same answer as a real user whose list happens
  // to be empty, arrived at by sending `{ userId: null }` to the `$match`.
  // #253.
  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
  assert.equal('detail' in body, false)
})

test('a real user with an empty list is still an empty list', options, async () => {
  seed()

  const { statusCode, body } = await call(entries, 'GET', 'entries/films/nil')

  assert.equal(statusCode, 200)
  assert.deepEqual(body, [])
})
