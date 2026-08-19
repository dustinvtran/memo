/**
 * @file What saving an entry writes when one of the writes refuses, driven
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
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const dependenciesInstalled = (() => {
  try {
    require('neverthrow')
    require('zod')
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

process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://in-memory'

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

const loadModule = Module._load
Module._load = function (request, ...args) {
  if (request === 'mongodb') return { MongoClient, ServerApiVersion: { v1: '1' } }
  // jose verifies asynchronously from v4 on, and answers with the payload
  // wrapped rather than the payload itself. A test's token is its user id.
  if (request === 'jose') {
    return { jwtVerify: async (token) => ({ payload: { sub: token } }) }
  }
  return loadModule.call(this, request, ...args)
}

const entries = dependenciesInstalled ? require('../routes/entries') : undefined
const revisions = dependenciesInstalled ? require('../routes/revisions') : undefined

///////////////////////////////////////////////////////////////////////////////

const call = async (route, method, url, { as, body } = {}) => {
  const response = await route.handler(
    {
      httpMethod: method,
      path: `/.netlify/functions/${url}`,
      headers: as ? { authorization: `Bearer ${as}` } : {},
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
  // work out for itself and had no way to read before.
  assert.equal(body.ref.id, store.filmEntries[0]._id)
  assert.equal(body.data.status, 'Completed')
  assert.equal(body.data.score, 9)
  assert.equal(body.data.userId, 'u1')

  // The note is written beside it rather than returned in its place.
  assert.equal(store.filmReviews[0].text, 'a first note')
  assert.equal(body.data.text, undefined)
  assert.equal(body.data.entryRef, undefined)
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
