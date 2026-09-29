/**
 * @file Personal API tokens, driven through the real Netlify handlers against
 * an in-memory Mongo: issuing one, using it on another route, and revoking
 * it — plus the refusals that make it safe to hand one to a script.
 *
 * Like `name.test.js`, these assert on the store as well as on the status
 * code, since "the token is stored only as its hash" is a claim about the
 * store. They need the dependencies, so the file **skips itself** when they
 * aren't installed.
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
// A Mongo small enough to keep in a variable.

const store = {}

let readsFail = false
let updatesFail = false

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([field, wanted]) => doc[field] === wanted)

const collectionOf = (name) => (store[name] = store[name] ?? [])

const collection = (name) => ({
  find: (filter) => ({
    toArray: async () => collectionOf(name).filter((doc) => matches(doc, filter)),
  }),
  findOne: async (filter) => {
    if (readsFail) throw new Error('read failed')
    return collectionOf(name).find((doc) => matches(doc, filter)) ?? null
  },
  insertOne: async (doc) => (collectionOf(name).push(doc), { insertedId: doc._id }),
  updateOne: async (filter, { $set }) => {
    if (updatesFail) throw new Error('update failed')
    const doc = collectionOf(name).find((d) => matches(d, filter))
    if (doc) Object.assign(doc, $set)
    return { modifiedCount: doc ? 1 : 0 }
  },
  deleteOne: async (filter) => {
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

const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}
const { tokenFor } = dependenciesInstalled ? await import('./test_tokens.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const tokens = dependenciesInstalled ? await import('../routes/tokens.js') : undefined
const name = dependenciesInstalled ? await import('../routes/name.js') : undefined
const bio = dependenciesInstalled ? await import('../routes/bio.js') : undefined
const { MAX_API_TOKENS_PER_USER } = dependenciesInstalled
  ? await import('./tokens.js')
  : { MAX_API_TOKENS_PER_USER: 0 }
const { MAX_API_TOKEN_LIFETIME_SECONDS, LAST_USED_RESOLUTION_MS } = dependenciesInstalled
  ? await import('../utils/api_token.js')
  : {}

///////////////////////////////////////////////////////////////////////////////

/**
 * `as` is a user id, for which a real session token is minted; `bearer` is a
 * credential sent exactly as given.
 */
const callRoute = async (route, method, url, { as, bearer, body, scheme = 'Bearer', headers } = {}) => {
  const credential = bearer ?? (as ? await tokenFor(as) : undefined)
  const response = await route.handler(
    {
      httpMethod: method,
      path: `/.netlify/functions/${url}`,
      headers: headers ?? (credential ? { authorization: `${scheme} ${credential}` } : {}),
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
  store.users = [
    { _id: 'a1', userId: 'u1', username: 'nil' },
    { _id: 'a2', userId: 'u2', username: 'other' },
  ]
  store.apiTokens = []
}

const issue = (as = 'u1', tokenName = 'claude', extra = {}) =>
  callRoute(tokens, 'POST', 'tokens', { as, body: { name: tokenName, ...extra } })

const DAY_MS = 24 * 3600 * 1000

///////////////////////////////////////////////////////////////////////////////

test('issuing a token answers it once and stores only its hash', options, async () => {
  seed()

  const { statusCode, body } = await issue()

  assert.equal(statusCode, 200)
  assert.match(body.token, /^memo_pat_[A-Za-z0-9_-]{43}$/)
  assert.equal(body.name, 'claude')
  assert.equal(store.apiTokens.length, 1)

  const [stored] = store.apiTokens
  assert.equal(stored.userId, 'u1')
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(stored).includes(body.token), false)
})

test('an API token authenticates as its owner on other routes', options, async () => {
  seed()
  const { body: { token } } = await issue()

  const read = await callRoute(name, 'GET', 'name', { bearer: token })
  assert.equal(read.statusCode, 200)
  assert.equal(read.body.username, 'nil')

  const write = await callRoute(bio, 'POST', 'bio', {
    bearer: token,
    body: { newBio: 'written with a token' },
  })
  assert.equal(write.statusCode, 200)
  assert.equal(store.users[0].biography, 'written with a token')
  assert.equal(store.users[1].biography, undefined)
})

test('a revoked token stops working', options, async () => {
  seed()
  const { body: { id, token } } = await issue()

  const revoked = await callRoute(tokens, 'DELETE', `tokens/${id}`, { as: 'u1' })
  assert.equal(revoked.statusCode, 200)
  assert.equal(store.apiTokens.length, 0)

  const { statusCode, body } = await callRoute(name, 'GET', 'name', { bearer: token })
  assert.equal(statusCode, 401)
  assert.equal(body.error, 'UnauthorizedError')
})

test('a token nobody was issued, or a mangled one, is a 401', options, async () => {
  seed()
  const { body: { token } } = await issue()

  for (const bearer of [
    'memo_pat_' + 'A'.repeat(43),
    token.slice(0, -1),
    'memo_pat_',
  ]) {
    const { statusCode } = await callRoute(name, 'GET', 'name', { bearer })
    assert.equal(statusCode, 401, bearer)
  }
})

test('a database that does not answer is a 500, not a 401', options, async () => {
  seed()
  const { body: { token } } = await issue()

  readsFail = true
  try {
    const { statusCode } = await callRoute(name, 'GET', 'name', { bearer: token })
    assert.equal(statusCode, 500)
  } finally {
    readsFail = false
  }
})

test('an API token cannot issue, list or revoke tokens', options, async () => {
  seed()
  const { body: { id, token } } = await issue()

  const attempts = [
    callRoute(tokens, 'POST', 'tokens', { bearer: token, body: { name: 'another' } }),
    callRoute(tokens, 'GET', 'tokens', { bearer: token }),
    callRoute(tokens, 'DELETE', `tokens/${id}`, { bearer: token }),
  ]

  for (const { statusCode } of await Promise.all(attempts)) {
    assert.equal(statusCode, 401)
  }
  assert.equal(store.apiTokens.length, 1)
})

test('listing shows a user their own tokens, without hashes', options, async () => {
  seed()
  await issue('u1', 'laptop')
  await issue('u1', 'claude')
  await issue('u2', 'theirs')

  const { statusCode, body } = await callRoute(tokens, 'GET', 'tokens', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.deepEqual(body.map((t) => t.name).sort(), ['claude', 'laptop'])
  for (const listed of body) {
    assert.deepEqual(
      Object.keys(listed).sort(),
      ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name']
    )
  }
})

test("someone else's token is a 404 and is not revoked", options, async () => {
  seed()
  const { body: { id } } = await issue('u2')

  const { statusCode } = await callRoute(tokens, 'DELETE', `tokens/${id}`, { as: 'u1' })

  assert.equal(statusCode, 404)
  assert.equal(store.apiTokens.length, 1)
})

test('a token needs a name', options, async () => {
  seed()

  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(65) }, { name: 5 }]) {
    const { statusCode } = await callRoute(tokens, 'POST', 'tokens', { as: 'u1', body })
    assert.equal(statusCode, 400, JSON.stringify(body))
  }
  assert.equal(store.apiTokens.length, 0)
})

test('issuing stops at the cap until one is revoked', options, async () => {
  seed()
  for (let i = 0; i < MAX_API_TOKENS_PER_USER; i++) await issue('u1', `t${i}`)

  const refused = await issue('u1', 'one too many')
  assert.equal(refused.statusCode, 409)
  assert.equal(store.apiTokens.length, MAX_API_TOKENS_PER_USER)

  const { body: [first] } = await callRoute(tokens, 'GET', 'tokens', { as: 'u1' })
  await callRoute(tokens, 'DELETE', `tokens/${first.id}`, { as: 'u1' })

  const accepted = await issue('u1', 'now there is room')
  assert.equal(accepted.statusCode, 200)
})

test('a session token still works everywhere it did', options, async () => {
  seed()

  const { statusCode, body } = await callRoute(name, 'GET', 'name', { as: 'u1' })

  assert.equal(statusCode, 200)
  assert.equal(body.username, 'nil')
})

test('a token never expires unless it is given a lifetime', options, async () => {
  seed()

  const { body: forever } = await issue('u1', 'forever')
  assert.equal(forever.expiresAt, null)
  assert.equal(store.apiTokens[0].expiresAt, null)

  const { body: explicit } = await issue('u1', 'explicit', { expiresInSeconds: null })
  assert.equal(explicit.expiresAt, null)

  for (const days of [30, 90]) {
    const { body } = await issue('u1', `${days} days`, { expiresInSeconds: days * 24 * 3600 })
    assert.equal(body.expiresAt, body.createdAt + days * 24 * 3600 * 1000)
  }
})

test('a never-expiring token still works long after it was made', options, async () => {
  seed()
  const { body: { token } } = await issue()
  store.apiTokens[0].createdAt = Date.now() - 10 * 365 * DAY_MS

  assert.equal((await callRoute(name, 'GET', 'name', { bearer: token })).statusCode, 200)
})

test('a lifetime that is not a whole positive number, or is absurdly long, is refused', options, async () => {
  seed()

  for (const expiresInSeconds of [MAX_API_TOKEN_LIFETIME_SECONDS + 1, 0, -5, 1.5, '3600']) {
    const { statusCode } = await issue('u1', 'claude', { expiresInSeconds })
    assert.equal(statusCode, 400, String(expiresInSeconds))
  }
  assert.equal(store.apiTokens.length, 0)
})

test('an expired token is a 401 that says so', options, async () => {
  seed()
  const { body: { token } } = await issue()
  store.apiTokens[0].expiresAt = Date.now() - 1

  const { statusCode, body } = await callRoute(name, 'GET', 'name', { bearer: token })

  assert.equal(statusCode, 401)
  assert.match(body.message, /expired/)
})

test('a token minted before expiresAt existed never expires', options, async () => {
  seed()
  const { body: { token } } = await issue()
  const [stored] = store.apiTokens
  delete stored.expiresAt
  stored.createdAt = Date.now() - 10 * 365 * DAY_MS

  assert.equal((await callRoute(name, 'GET', 'name', { bearer: token })).statusCode, 200)
  const { body: [listed] } = await callRoute(tokens, 'GET', 'tokens', { as: 'u1' })
  assert.equal(listed.expiresAt, null)
})

test('using a token records when, at most once an hour', options, async () => {
  seed()
  const { body: { token } } = await issue()
  const [stored] = store.apiTokens
  assert.equal(stored.lastUsedAt, undefined)

  const before = Date.now()
  await callRoute(name, 'GET', 'name', { bearer: token })
  assert.ok(stored.lastUsedAt >= before)

  const recent = Date.now() - LAST_USED_RESOLUTION_MS + 60 * 1000
  stored.lastUsedAt = recent
  await callRoute(name, 'GET', 'name', { bearer: token })
  assert.equal(stored.lastUsedAt, recent)

  stored.lastUsedAt = Date.now() - LAST_USED_RESOLUTION_MS
  await callRoute(name, 'GET', 'name', { bearer: token })
  assert.ok(stored.lastUsedAt >= before)

  const { body: [listed] } = await callRoute(tokens, 'GET', 'tokens', { as: 'u1' })
  assert.equal(listed.lastUsedAt, stored.lastUsedAt)
})

test('a lastUsedAt that cannot be written does not fail the request', options, async () => {
  seed()
  const { body: { token } } = await issue()

  updatesFail = true
  try {
    const { statusCode } = await callRoute(name, 'GET', 'name', { bearer: token })
    assert.equal(statusCode, 200)
  } finally {
    updatesFail = false
  }
})

test('an expired token does not count towards the cap', options, async () => {
  seed()
  for (let i = 0; i < MAX_API_TOKENS_PER_USER; i++) await issue('u1', `t${i}`)
  store.apiTokens[0].expiresAt = Date.now() - 1

  const accepted = await issue('u1', 'room made by expiry')
  assert.equal(accepted.statusCode, 200)
})

test('the Bearer scheme is recognised whatever its case', options, async () => {
  seed()
  const { body: { token } } = await issue()

  for (const scheme of ['bearer', 'BEARER']) {
    const withToken = await callRoute(name, 'GET', 'name', { bearer: token, scheme })
    assert.equal(withToken.statusCode, 200, scheme)
    const withSession = await callRoute(name, 'GET', 'name', { as: 'u1', scheme })
    assert.equal(withSession.statusCode, 200, scheme)
  }
})

///////////////////////////////////////////////////////////////////////////////
// The session as the browser sends it: a cookie, since #501 made it httpOnly.

const cookieFor = async (userId) => `other=1; nf_jwt=${await tokenFor(userId)}; memo_session=1`

test('a session cookie with no Authorization header signs a read in', options, async () => {
  seed()

  const { statusCode, body } = await callRoute(name, 'GET', 'name', {
    headers: { cookie: await cookieFor('u1') },
  })

  assert.equal(statusCode, 200)
  assert.equal(body.username, 'nil')
})

test('a write signed in by cookie needs the X-Requested-With header', options, async () => {
  seed()
  const cookie = await cookieFor('u1')
  const write = (headers) => callRoute(bio, 'POST', 'bio', {
    headers,
    body: { newBio: 'written by cookie' },
  })

  const forged = await write({ cookie })
  assert.equal(forged.statusCode, 401)
  assert.match(forged.body.message, /x-requested-with/)
  assert.equal(store.users[0].biography, undefined)

  const ours = await write({ cookie, 'x-requested-with': 'memo' })
  assert.equal(ours.statusCode, 200)
  assert.equal(store.users[0].biography, 'written by cookie')
})

test('the hint cookie alone is no session', options, async () => {
  seed()

  const { statusCode } = await callRoute(name, 'GET', 'name', {
    headers: { cookie: 'memo_session=9999999999' },
  })

  assert.equal(statusCode, 401)
})

test('a session cookie can manage tokens, as the profile page will', options, async () => {
  seed()
  const cookie = await cookieFor('u1')

  const issued = await callRoute(tokens, 'POST', 'tokens', {
    headers: { cookie, 'x-requested-with': 'memo' },
    body: { name: 'from the browser' },
  })
  assert.equal(issued.statusCode, 200)

  const listed = await callRoute(tokens, 'GET', 'tokens', { headers: { cookie } })
  assert.deepEqual(listed.body.map((t) => t.name), ['from the browser'])
})

test('an API token needs no X-Requested-With, since a forged request cannot carry one', options, async () => {
  seed()
  const { body: { token } } = await issue()

  const { statusCode } = await callRoute(bio, 'POST', 'bio', {
    headers: { authorization: `Bearer ${token}` },
    body: { newBio: 'from a script' },
  })

  assert.equal(statusCode, 200)
})
