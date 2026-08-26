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

/** An adapter answers with a ResultAsync, so the stub below has to as well. */
const { okAsync } = dependenciesInstalled ? await import('neverthrow') : {}

process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://in-memory'
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'

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

/**
 * What `retrieve` answers with, so that a test can hand back a work the
 * parser will refuse. Reset by `seed`.
 */
let retrieved = retrievedFilm

const stubAdapter = {
  search: (query) => {
    adapterCalls.push({ action: 'search', arg: query })
    return okAsync([{ title: 'Stalker', ref: '1234' }])
  },
  retrieve: (ref) => {
    adapterCalls.push({ action: 'retrieve', arg: ref })
    return okAsync(retrieved(ref))
  },
}

/* The in-memory Mongo goes in through the seam `db.js` leaves for it, rather
   than by intercepting `require('mongodb')`. ES modules have no `Module._load`,
   and that patch was the only thing keeping this tree on CommonJS — see
   `docs/module_system.md`. The tokens are real for the same reason. */
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { useAdapters } = dependenciesInstalled
  ? await import('../utils/external_api_adapters/index.js')
  : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) {
  useClient(new MongoClient())
  /* The three real adapters want a TMDB, an IGDB and a Google Books key that
     this suite deliberately does not have. They no longer ask for one until a
     request does, so these simply replace them. */
  useAdapters({
    films: stubAdapter, tv: stubAdapter, games: stubAdapter, books: stubAdapter,
  })
}

const works = dependenciesInstalled ? await import('../routes/works.js') : undefined

///////////////////////////////////////////////////////////////////////////////

const call = async (url, { as } = {}) => {
  const response = await works.handler(
    {
      httpMethod: 'GET',
      path: `/.netlify/functions/${url}`,
      headers: as ? { authorization: `Bearer ${await tokenFor(as)}` } : {},
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
  retrieved = retrievedFilm
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

///////////////////////////////////////////////////////////////////////////////
// A work the parser refuses. `_create` used to throw this synchronously, and
// `createWork` calls it inside an `.andThen` with nothing around it, so the
// error left the module past every `mapErr(responses.fromError)` above it and
// out of the handler: `await works.handler(...)` rejected, and Netlify
// answered an empty 502. #213.

test('a retrieved work the parser refuses is a 400 rather than a throw', options, async () => {
  seed()
  // No `englishTranslatedTitle`, which `workParser` has as
  // `z.string().nullable()` with no `.optional()`. Any adapter that answers
  // with an untitled work reaches this; #214 is another way in.
  retrieved = (ref) => ({ apiRefs: [`tmdb__${ref}`], entryType: 'Film' })

  const { statusCode, body } = await call('works/retrieve/films/1234', { as: 'u1' })

  assert.equal(statusCode, 400)
  // The parser's own class, and not `DBError`: the database was never asked.
  assert.equal(body.error, 'RequestError')
  assert.equal(body.message, 'the request body is not valid')

  // Zod's account of our field layout is logged rather than sent. #105.
  assert.equal(body.detail, undefined)

  assert.deepEqual(store.films, [])
})

test('a work the parser refuses is not half-written before it is refused', options, async () => {
  seed()
  retrieved = (ref) => ({ apiRefs: [`tmdb__${ref}`], entryType: 'Opera' })

  await call('works/retrieve/films/1234', { as: 'u1' })

  // The retrieve was spent — the write is what did not happen.
  assert.deepEqual(adapterCalls, [{ action: 'retrieve', arg: '1234' }])
  assert.deepEqual(store.films, [])
})
