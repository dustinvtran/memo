/**
 * @file Claiming a username, driven through the real Netlify handler against
 * an in-memory Mongo.
 *
 * The point of these is that a 200 from `POST /api/name` means the name was
 * written — the previous version answered 200 while writing nothing — so they
 * assert on the store, not just on the status code. That needs the actual
 * dependencies, so the file **skips itself** when they aren't installed
 * (which is how CI runs the suite).
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

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
/* The jose below takes every token at its word, but `getUserId` asks for the
   signing key before it gets there, and a key of no bytes is refused now. */
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

///////////////////////////////////////////////////////////////////////////////
// A Mongo small enough to keep in a variable, and an auth check that takes
// the token at its word — neither is what these tests are about.

const store = {}

// The connection is made once and held, so a test that wants a write to fail
// has to say so here rather than swap the client out from under it.
let writesFail = false

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
    if (writesFail) throw new Error('write failed')
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

const name = dependenciesInstalled ? require('../routes/name') : undefined

///////////////////////////////////////////////////////////////////////////////

const call = async (method, url, { as, body } = {}) => {
  const response = await name.handler(
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
  store.users = [{ _id: 'a1', userId: 'u1', username: 'oldname' }]
}

///////////////////////////////////////////////////////////////////////////////

test('renaming writes the new name, flat, on the existing document', options, async () => {
  seed()

  const { statusCode } = await call('POST', 'name', {
    as: 'u1',
    body: { newName: 'newname' },
  })

  assert.equal(statusCode, 200)
  assert.equal(store.users.length, 1)
  assert.equal(store.users[0].username, 'newname')
  // Not `{ data: { username } }` — nothing reads a nested copy.
  assert.equal('data' in store.users[0], false)
})

test('the rename is read back by the route that answers with it', options, async () => {
  seed()
  await call('POST', 'name', { as: 'u1', body: { newName: 'newname' } })

  const { body } = await call('GET', 'name', { as: 'u1' })

  assert.equal(body.username, 'newname')
})

test('a first-time user gets a document created', options, async () => {
  store.users = []

  const { statusCode } = await call('POST', 'name', {
    as: 'u2',
    body: { newName: 'brandnew' },
  })

  assert.equal(statusCode, 200)
  assert.equal(store.users.length, 1)
  assert.equal(store.users[0].userId, 'u2')
  assert.equal(store.users[0].username, 'brandnew')
})

test('a taken name is refused and changes nothing', options, async () => {
  seed()
  store.users.push({ _id: 'a2', userId: 'u2', username: 'taken' })

  const { body } = await call('POST', 'name', {
    as: 'u1',
    body: { newName: 'taken' },
  })

  assert.equal(body.error, 'NameTaken')
  assert.equal(store.users[0].username, 'oldname')
})

test('a write that fails is not answered with a 200', options, async () => {
  seed()

  writesFail = true

  try {
    const { statusCode } = await call('POST', 'name', {
      as: 'u1',
      body: { newName: 'newname' },
    })

    assert.equal(statusCode, 500)
    assert.equal(store.users[0].username, 'oldname')
  } finally {
    writesFail = false
  }
})
