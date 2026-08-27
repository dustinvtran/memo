/**
 * @file The two fields a request may write onto a user document — the username
 * and the biography — driven through the real Netlify handlers against an
 * in-memory Mongo.
 *
 * Both live here rather than in a file each because they are the same write:
 * `name.js` and `bio.js` both reach `updateByRef_`, which parses nothing, and
 * both therefore need the users parser run by hand on the way in. One fake
 * Mongo serves both.
 *
 * The point of these is that a 200 from `POST /api/name` means the name was
 * written — the previous version answered 200 while writing nothing — so they
 * assert on the store, not just on the status code. That needs the actual
 * dependencies, so the file **skips itself** when they aren't installed
 * (which is how CI runs the suite).
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

// The connection is made once and held, so a test that wants a query to fail
// has to say so here rather than swap the client out from under it.
let writesFail = false
let readsFail = false

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
    if (readsFail) throw new Error('read failed')
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

/* The in-memory Mongo goes in through the seam `db.js` leaves for it, rather
   than by intercepting `require('mongodb')`. ES modules have no `Module._load`,
   and that patch was the only thing keeping this tree on CommonJS — see
   `docs/module_system.md`. The tokens are real for the same reason. */
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const name = dependenciesInstalled ? await import('../routes/name.js') : undefined
const bio = dependenciesInstalled ? await import('../routes/bio.js') : undefined
const { MAX_BIOGRAPHY_LENGTH } = dependenciesInstalled
  ? await import('../utils/parsers/users.js')
  : { MAX_BIOGRAPHY_LENGTH: 0 }

///////////////////////////////////////////////////////////////////////////////

const call = (method, url, options) => callRoute(name, method, url, options)

const callBio = (body, { as } = { as: 'u1' }) =>
  callRoute(bio, 'POST', 'bio', { as, body })

const callRoute = async (route, method, url, { as, body } = {}) => {
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

///////////////////////////////////////////////////////////////////////////////
// GET /api/name, which used to answer `200 {}` to everything that went wrong.
// The home page reads that body as a user who has no name — neither of its
// failure branches is taken by `{}` — and greets them as `Hi undefined!`. #216.

test('a caller with no token at all is refused', options, async () => {
  seed()

  const { statusCode, body } = await call('GET', 'name')

  assert.equal(statusCode, 401)
  assert.equal(body.error, 'UnauthorizedError')
})

test('an expired token is a 401 rather than a 200 with nothing in it', options, async () => {
  seed()

  // The case the frontend cannot tell from a fresh one on its own: `isLoggedIn`
  // is the presence of the `nf_jwt` cookie and nothing about whether it still
  // verifies, so this answer is the only thing that knows the session is over.
  const { statusCode, body } = await call('GET', 'name', { as: 'expired' })

  assert.equal(statusCode, 401)
  assert.equal(body.error, 'UnauthorizedError')
})

test('a database that does not answer is a 500', options, async () => {
  seed()

  readsFail = true

  try {
    const { statusCode, body } = await call('GET', 'name', { as: 'u1' })

    assert.equal(statusCode, 500)
    assert.equal(body.error, 'DBError')
  } finally {
    readsFail = false
  }
})

test('an account that has not picked a name is still a 200', options, async () => {
  // Not swept up with the failures above: `NoUsernameSet` is a real answer to
  // a real question, and the UsernameSetter on the home page is drawn from it.
  store.users = []

  const { statusCode, body } = await call('GET', 'name', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.equal(body.error, 'NoUsernameSet')
})

///////////////////////////////////////////////////////////////////////////////
// The rule in the users parser, on the path that never ran it. `create_`
// parses and `updateByRef_` does not, so `max(16).min(2)` alphanumeric applied
// to an account claiming its first name and to no rename after it. #172.

const refusedNames = {
  'markup, which the profile page interpolates': '<img src=x onerror=alert(1)>',
  'a name longer than the limit': 'a'.repeat(17),
  'a name shorter than the limit': 'a',
  'punctuation that is not alphanumeric': 'nil.moe',
  'a space': 'two words',
  'the empty string': '',
}

for (const [what, newName] of Object.entries(refusedNames)) {
  test(`a rename refuses ${what}`, options, async () => {
    seed()

    const { statusCode } = await call('POST', 'name', {
      as: 'u1',
      body: { newName },
    })

    assert.equal(statusCode, 400)
    assert.equal(store.users[0].username, 'oldname')
  })
}

/**
 * `event.body` is `string | null`, and `JSON.parse(null)` is `null` rather
 * than a parse error — so a POST with nothing in it reached `({ newName })`
 * and threw where neverthrow does not catch, out of the handler and out as
 * an empty 502. #259.
 */
test('a rename with no body at all is a 400 rather than a 502', options, async () => {
  seed()

  const { statusCode, body } = await call('POST', 'name', { as: 'u1' })

  assert.equal(statusCode, 400)
  assert.equal(body.error, 'RequestError')
  assert.equal(store.users[0].username, 'oldname')
})

test('a rename whose body is not an object at all is a 400 too', options, async () => {
  seed()

  // Valid JSON, and nothing a destructure can be taken from either. This
  // one never threw — `({ newName })` off a number is `undefined`, which
  // the users parser refuses a step later — so it is the message being
  // asserted: the body is turned away for its shape, before any route has
  // read a field off it.
  const { statusCode, body } = await call('POST', 'name', { as: 'u1', body: 5 })

  assert.equal(statusCode, 400)
  assert.equal(body.error, 'RequestError')
  assert.equal(body.message, 'the request body must be a JSON object')
  assert.equal(store.users[0].username, 'oldname')
})

test('a rename refuses a value that is not a string at all', options, async () => {
  seed()

  // `{ $ne: null }` reaching `findOneByField_` is a filter rather than a name:
  // it matches whatever user happens to be there and answers "taken". It has
  // to be refused before the lookup, not just before the write.
  const { statusCode } = await call('POST', 'name', {
    as: 'u1',
    body: { newName: { $ne: null } },
  })

  assert.equal(statusCode, 400)
  assert.equal(store.users[0].username, 'oldname')
})

test('an ordinary rename still goes through', options, async () => {
  seed()

  const { statusCode } = await call('POST', 'name', {
    as: 'u1',
    body: { newName: 'nil2' },
  })

  assert.equal(statusCode, 200)
  assert.equal(store.users[0].username, 'nil2')
})

///////////////////////////////////////////////////////////////////////////////
// The biography, which reaches `updateByRef_` the same way and had no bound on
// its length or even its type. #172.

test('a biography is written when it is a string within the limit', options, async () => {
  seed()

  const { statusCode } = await callBio({ newBio: '# hello\n\nsome *markdown*' })

  assert.equal(statusCode, 200)
  assert.equal(store.users[0].biography, '# hello\n\nsome *markdown*')
})

test('clearing a biography is allowed', options, async () => {
  seed()
  store.users[0].biography = 'something'

  const { statusCode } = await callBio({ newBio: '' })

  assert.equal(statusCode, 200)
  assert.equal(store.users[0].biography, '')
})

test('a biography past the limit is refused and nothing is written', options, async () => {
  seed()
  store.users[0].biography = 'what was there before'

  const { statusCode } = await callBio({
    newBio: 'a'.repeat(MAX_BIOGRAPHY_LENGTH + 1),
  })

  assert.equal(statusCode, 400)
  assert.equal(store.users[0].biography, 'what was there before')
})

test('a biography of the wrong type is refused', options, async () => {
  seed()
  store.users[0].biography = 'what was there before'

  const { statusCode } = await callBio({ newBio: { $ne: null } })

  assert.equal(statusCode, 400)
  assert.equal(store.users[0].biography, 'what was there before')
})

test('a biography POST with no body at all is a 400 rather than a 502', options, async () => {
  seed()
  store.users[0].biography = 'what was there before'

  // The same null body as the rename above, one destructure along. #259.
  const { statusCode, body } = await callBio()

  assert.equal(statusCode, 400)
  assert.equal(body.error, 'RequestError')
  assert.equal(store.users[0].biography, 'what was there before')
})
