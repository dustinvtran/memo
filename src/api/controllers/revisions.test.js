/**
 * @file The edit history and the draft, driven through the real Netlify
 * handlers against an in-memory Mongo.
 *
 * The rules live in ../utils/revision_history.js and are tested there without
 * anything installed. This covers the wiring around them — what a save
 * records, who is allowed to read it, and what a delete takes with it —
 * which needs the actual dependencies, so it **skips itself** when they
 * aren't installed (which is how CI runs the suite).
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
/* The jose below takes every token at its word, but `getUserId` asks for the
   signing key before it gets there, and a key of no bytes is refused now. */
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

///////////////////////////////////////////////////////////////////////////////
// A Mongo small enough to keep in a variable, and an auth check that takes
// the token at its word — neither is what these tests are about.

const store = {}

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

/**
 * `_id` comes back unless the projection excludes it, and an inclusion
 * projection drops everything it doesn't name. A double that returned whole
 * documents regardless would let a query that forgot a field still pass.
 */
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

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () =>
      collectionOf(name).filter((doc) => matches(doc, pipeline[0].$match)),
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
  deleteMany: async (filter) => {
    const before = collectionOf(name).length
    store[name] = collectionOf(name).filter((doc) => !matches(doc, filter))
    return { deletedCount: before - store[name].length }
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
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const entries = dependenciesInstalled ? await import('../routes/entries.js') : undefined
const revisions = dependenciesInstalled ? await import('../routes/revisions.js') : undefined

///////////////////////////////////////////////////////////////////////////////

/** @param {'films'|'books'|'tv'|'games'} _type */
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
  store.filmReviews = [
    { _id: 'r1', entryRef: 'e1', text: 'first note\nsecond line' },
  ]
  store.entryRevisions = []
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

/** What the entry form sends when the user saves. */
const edit = (extra) => ({
  commonMetadata: null,
  workRef: 'w1',
  overrides: { englishTranslatedTitle: 'Stalker', genres: null },
  status: 'Completed',
  score: 9,
  startedDate: 1700000000000,
  completedDate: 1700100000000,
  review: 'first note\nrewritten line',
  ...extra,
})

///////////////////////////////////////////////////////////////////////////////

test('a save records the version it replaced, review included', options, async () => {
  seed()

  const { statusCode } = await call(entries, 'PATCH', 'entries/films/e1', {
    as: 'u1',
    body: edit(),
  })

  assert.equal(statusCode, 200)
  assert.equal(store.entryRevisions.length, 1)

  const [revision] = store.entryRevisions
  assert.equal(revision.kind, 'revision')
  assert.equal(revision.entryRef, 'e1')
  assert.equal(revision.entryType, 'Film')
  assert.equal(revision.userId, 'u1')
  assert.equal(revision.createdDate, 1700000000000)
  assert.deepEqual(revision.snapshot, {
    status: 'InProgress',
    score: 7,
    startedDate: 1700000000000,
    workRef: 'w1',
    review: 'first note\nsecond line',
  })

  // The entry itself holds the new version.
  assert.equal(store.filmEntries[0].status, 'Completed')
  assert.equal(store.filmReviews[0].text, 'first note\nrewritten line')
})

test('the history reads back newest first, saying what each version changed', options, async () => {
  seed()
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })

  const { statusCode, body } = await call(
    revisions,
    'GET',
    'revisions/films/e1',
    { as: 'u1' }
  )

  assert.equal(statusCode, 200)
  assert.equal(body.versions.length, 2)

  const [current, previous] = body.versions
  assert.equal(current.isCurrent, true)
  assert.deepEqual(current.changes, [
    'status',
    'score',
    'completedDate',
    'review',
    'overrides.englishTranslatedTitle',
  ])
  assert.equal(current.snapshot.review, 'first note\nrewritten line')
  assert.equal(previous.isCurrent, false)
  // Nothing is known about what came before the oldest version we hold.
  assert.deepEqual(previous.changes, [])
  assert.equal(previous.snapshot.review, 'first note\nsecond line')
})

test('a save that changes nothing records nothing', options, async () => {
  seed()
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })

  assert.equal(store.entryRevisions.length, 1)
})

test('an entry saved before updatedDate existed still gets a history', options, async () => {
  seed()
  delete store.filmEntries[0].updatedDate

  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })

  assert.equal(store.entryRevisions.length, 1)
  assert.equal(typeof store.entryRevisions[0].createdDate, 'number')
})

test('history is capped, and it is the oldest versions that go', options, async () => {
  seed()

  for (let i = 0; i < 55; i++) {
    // A version is dated by the save it came from, and 55 saves inside one
    // millisecond would date them all the same, leaving "the oldest" up to
    // the sort. Nobody edits that fast; the test shouldn't pretend to.
    await tick()
    await call(entries, 'PATCH', 'entries/films/e1', {
      as: 'u1',
      body: edit({ review: `note ${i}` }),
    })
  }

  assert.equal(store.entryRevisions.length, 50)
  const kept = store.entryRevisions.map(({ snapshot }) => snapshot.review)
  assert.equal(kept.includes('note 0'), false)
  assert.equal(kept.includes('note 53'), true)
})

test('history and drafts belong to the owner alone', options, async () => {
  seed()

  assert.equal(
    (await call(revisions, 'GET', 'revisions/films/e1', { as: 'someone-else' }))
      .statusCode,
    401
  )
  assert.equal(
    (
      await call(revisions, 'PUT', 'revisions/films/e1/draft', {
        as: 'someone-else',
        body: edit(),
      })
    ).statusCode,
    401
  )
  assert.deepEqual(store.entryRevisions, [])
})

test('a draft is stored, read back, and replaced rather than piled up', options, async () => {
  seed()

  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: edit({ review: 'a draft in progress' }),
  })
  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: edit({ review: 'a draft, further along' }),
  })

  assert.equal(store.entryRevisions.length, 1)

  const { body } = await call(revisions, 'GET', 'revisions/films/e1/draft', {
    as: 'u1',
  })
  assert.equal(body.draft.snapshot.review, 'a draft, further along')
  // Whatever else the form sent is not kept.
  assert.equal('commonMetadata' in body.draft.snapshot, false)
})

test('a draft is not history until it is saved for real', options, async () => {
  seed()
  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: edit({ review: 'a draft in progress' }),
  })

  const versions = await call(revisions, 'GET', 'revisions/films/e1', {
    as: 'u1',
  })
  assert.equal(versions.body.versions.length, 1)
  assert.equal(versions.body.versions[0].isCurrent, true)

  // Saving the entry is what the draft was waiting for, so it goes.
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })

  const draft = await call(revisions, 'GET', 'revisions/films/e1/draft', {
    as: 'u1',
  })
  assert.equal(draft.body.draft, null)
})

test('deleting an entry takes its history and its draft with it', options, async () => {
  seed()
  await call(entries, 'PATCH', 'entries/films/e1', { as: 'u1', body: edit() })
  await call(revisions, 'PUT', 'revisions/films/e1/draft', {
    as: 'u1',
    body: edit({ review: 'a draft' }),
  })
  assert.equal(store.entryRevisions.length, 2)

  const { statusCode } = await call(entries, 'DELETE', 'entries/films/e1', {
    as: 'u1',
  })

  assert.equal(statusCode, 200)
  assert.deepEqual(store.entryRevisions, [])
})

test('an unknown sub-resource is a 404, and so is an unknown type', options, async () => {
  seed()

  assert.equal(
    (await call(revisions, 'GET', 'revisions/films/e1/whatever', { as: 'u1' }))
      .statusCode,
    404
  )
  assert.equal(
    (await call(revisions, 'GET', 'revisions/nonsense/e1', { as: 'u1' }))
      .statusCode,
    404
  )
})

test('an entry that has never been edited is its current version alone', options, async () => {
  seed()

  const { body } = await call(revisions, 'GET', 'revisions/films/e1', {
    as: 'u1',
  })

  assert.equal(body.versions.length, 1)
  assert.deepEqual(body.versions[0].snapshot, {
    status: 'InProgress',
    score: 7,
    startedDate: 1700000000000,
    workRef: 'w1',
    review: 'first note\nsecond line',
  })
})
