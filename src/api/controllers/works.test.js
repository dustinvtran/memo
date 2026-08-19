/**
 * @file Who may reach /api/works, driven through the real Netlify handler
 * against an in-memory Mongo and a stubbed adapter.
 *
 * These two routes were open to anyone (#174), and what that cost is not
 * visible in a status code: `search` spends TMDB, IGDB and Google Books
 * credentials, and `retrieve` writes a work document on a cache miss. So the
 * assertions are that the adapter was not called and that nothing was
 * written, not merely that a 401 came back.
 *
 * The adapter is stubbed rather than mocked at the network: the real one
 * builds its client at require time and throws without an API key, which is
 * why nothing that requires it can be reached from `node --test` at all. That
 * is also the honest boundary of this file — the question here is who gets to
 * the adapter, not what it answers.
 *
 * Needs the dependencies (zod parses the work that gets written), so it
 * **skips itself** when they aren't installed, which is how CI runs the
 * suite.
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

/** An adapter answers with a ResultAsync, so the stub below has to as well. */
const { okAsync } = dependenciesInstalled ? require('neverthrow') : {}

process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://in-memory'

///////////////////////////////////////////////////////////////////////////////
// A Mongo small enough to keep in a variable, an auth check that takes the
// token at its word, and an adapter that counts what reaches it.

const store = {}

/** Every call that got through to a third-party API, as `{ action, arg }`. */
const adapterCalls = []

/**
 * Only the operator the queries in this module actually use. `apiRefs` is an
 * array field asked about with a plain string, which Mongo matches against
 * each element — a fake comparing the array itself would never find a cached
 * work, and every test would silently take the write path.
 */
const matchesValue = (value, wanted) =>
  Array.isArray(value) ? value.includes(wanted) : value === wanted

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([field, wanted]) =>
    matchesValue(doc[field], wanted)
  )

const collectionOf = (name) => (store[name] = store[name] ?? [])

const collection = (name) => ({
  findOne: async (filter) =>
    collectionOf(name).find((doc) => matches(doc, filter)) ?? null,
  insertOne: async (doc) => (collectionOf(name).push(doc), { insertedId: doc._id }),
})

class MongoClient {
  async connect() {}
  db() {
    return { databaseName: 'memo', collection }
  }
}

/** What TMDB would answer with, reduced to what the films parser insists on. */
const retrievedFilm = (ref) => ({
  apiRefs: [`tmdb__${ref}`],
  entryType: 'Film',
  englishTranslatedTitle: 'Stalker',
  releaseYear: 1979,
})

const stubAdapter = {
  search: (query) => {
    adapterCalls.push({ action: 'search', arg: query })
    return okAsync([{ title: 'Stalker', ref: '1234' }])
  },
  retrieve: (ref) => {
    adapterCalls.push({ action: 'retrieve', arg: ref })
    return okAsync(retrievedFilm(ref))
  },
}

const loadModule = Module._load
Module._load = function (request, ...args) {
  if (request === 'mongodb') return { MongoClient, ServerApiVersion: { v1: '1' } }
  // jose verifies asynchronously from v4 on, and answers with the payload
  // wrapped rather than the payload itself. A test's token is its user id,
  // except `expired`: a token that fails verification rejects rather than
  // throws, and this route has to answer 401 to that too. See #168.
  if (request === 'jose') {
    return {
      jwtVerify: async (token) => token === 'expired'
        ? Promise.reject(new Error('token expired'))
        : { payload: { sub: token } },
    }
  }
  // The real index builds a TMDB, an IGDB and a Google Books client at
  // require time, each from a key this suite deliberately does not have.
  if (request === '../utils/external_api_adapters') {
    return { films: stubAdapter, tv: stubAdapter, games: stubAdapter, books: stubAdapter }
  }
  return loadModule.call(this, request, ...args)
}

const works = dependenciesInstalled ? require('../routes/works') : undefined

///////////////////////////////////////////////////////////////////////////////

const call = async (url, { as } = {}) => {
  const response = await works.handler(
    {
      httpMethod: 'GET',
      path: `/.netlify/functions/${url}`,
      headers: as ? { authorization: `Bearer ${as}` } : {},
      body: null,
    },
    {}
  )
  return {
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

const seed = () => {
  adapterCalls.length = 0
  store.films = []
}

const seedCachedFilm = () => {
  seed()
  store.films = [{ _id: 'w1', ...retrievedFilm('1234') }]
}

///////////////////////////////////////////////////////////////////////////////

test('a search without a token is refused before it spends an API call', options, async () => {
  seed()

  const { statusCode, body } = await call('works/search/films/stalker')

  assert.equal(statusCode, 401)
  assert.equal(body.error, 'UnauthorizedError')
  assert.deepEqual(adapterCalls, [])
})

test('a retrieve without a token is refused and writes nothing', options, async () => {
  seed()

  const { statusCode } = await call('works/retrieve/films/1234')

  assert.equal(statusCode, 401)
  assert.deepEqual(adapterCalls, [])
  // The point of the issue: walking an API's ids anonymously filled this
  // collection with works no entry points at.
  assert.deepEqual(store.films, [])
})

test('a token that does not verify is refused too', options, async () => {
  seed()

  const { statusCode } = await call('works/search/films/stalker', { as: 'expired' })

  assert.equal(statusCode, 401)
  assert.deepEqual(adapterCalls, [])
})

test('an anonymous caller is an unknown caller before it is an unknown type', options, async () => {
  seed()

  const { body } = await call('works/retrieve/operas/1234')

  assert.equal(body.error, 'UnauthorizedError')
})

test('a logged-in user still gets their search', options, async () => {
  seed()

  const { statusCode, body } = await call('works/search/films/stalker', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.deepEqual(body, [{ title: 'Stalker', ref: '1234' }])
  assert.deepEqual(adapterCalls, [{ action: 'search', arg: 'stalker' }])
})

test('a logged-in retrieve of a cached work answers from the store', options, async () => {
  seedCachedFilm()

  const { statusCode, body } = await call('works/retrieve/films/1234', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.equal(body.internalRef, 'w1')
  assert.equal(body.englishTranslatedTitle, 'Stalker')
  assert.deepEqual(adapterCalls, [])
  assert.equal(store.films.length, 1)
})

test('a logged-in retrieve of an uncached work retrieves it and writes it', options, async () => {
  seed()

  const { statusCode, body } = await call('works/retrieve/films/1234', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.deepEqual(adapterCalls, [{ action: 'retrieve', arg: '1234' }])
  assert.equal(store.films.length, 1)
  assert.equal(store.films[0].englishTranslatedTitle, 'Stalker')
  assert.equal(body.internalRef, store.films[0]._id)
})

test('a logged-in request for an unknown type is a 404', options, async () => {
  seed()

  const { statusCode } = await call('works/retrieve/operas/1234', { as: 'u1' })

  assert.equal(statusCode, 404)
  assert.deepEqual(adapterCalls, [])
})
