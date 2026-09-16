/**
 * @file The two 404s of `GET /api/export`, driven through the real Netlify
 * handler against an in-memory Mongo.
 *
 * #280. Both were written `errors.notFound(<the sentence>)`, and `errors.js`
 * takes `(detail, message)` — so both sentences went to the function log and
 * the caller got `STOCK_MESSAGES.NotFound`, "not found". These assert the
 * body and not only the status, because the status was never the part that
 * was wrong: a test on `statusCode === 404` passed the whole time.
 *
 * The console assertions are the other half of the same bug. `no such user:
 * ${username}` was a log line written out of an unauthenticated route's own
 * url segment, one per request, carrying whatever the caller sent — the write
 * `findOneByFieldOrFail_` refuses to make, and for this reason. So these
 * check that nothing is logged at all rather than that the right thing is
 * sent.
 *
 * The 200 at the end is the control for the second: a db seam that found
 * nobody would answer 404 for a real user too, and the test above it would
 * pass on that just as happily.
 *
 * The headers after it are #300, and this route is where they are worth
 * checking: it is the only one that answers two content types off one path,
 * and `asText` builds the Markdown response's headers itself rather than
 * going through `responses.js`, so JSON passing proves nothing about
 * Markdown.
 *
 * That needs the actual dependencies, so the file **skips itself** when they
 * aren't installed — which is how the `test` job runs the suite. The `build`
 * job installs them and asserts nothing skips.
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
// A Mongo small enough to keep in a variable — the same one stats.test.js
// keeps, with the `$sort`, `$lookup` and `$project` this route's pipeline adds
// to the `$match` that one needed.

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

/** `{ updatedDate: -1, _id: 1 }`, in the order the keys are written. */
const bySortSpec = (spec) => (a, b) =>
  Object.entries(spec).reduce(
    (order, [field, direction]) =>
      order !== 0 ? order
        : a[field] === b[field] ? 0
        : (a[field] < b[field] ? -1 : 1) * direction,
    0
  )

/** Exclusion only, which is all `toUserEntriesPipeline` asks for. */
const withoutFields = (doc, projection) =>
  Object.fromEntries(
    Object.entries(doc).filter(([field]) => !(field in projection))
  )

const applyStage = (rows, stage) => {
  if (stage.$match) return rows.filter((doc) => matches(doc, stage.$match))
  if (stage.$sort) return [...rows].sort(bySortSpec(stage.$sort))
  if (stage.$limit) return rows.slice(0, stage.$limit)
  if (stage.$project) return rows.map((doc) => withoutFields(doc, stage.$project))
  if (stage.$lookup) {
    const { from, localField, foreignField, as } = stage.$lookup
    return rows.map((doc) => ({
      ...doc,
      [as]: collectionOf(from).filter(
        (joined) => joined[foreignField] === doc[localField]
      ),
    }))
  }
  // Louder than quietly passing the rows through: a stage this doesn't know
  // is a pipeline it is no longer standing in for.
  throw new Error(`the fake Mongo has no ${Object.keys(stage).join(', ')}`)
}

const collection = (name) => ({
  aggregate: (pipeline) => ({
    toArray: async () => pipeline.reduce(applyStage, collectionOf(name)),
  }),
  find: (filter) => ({
    toArray: async () => collectionOf(name).filter((doc) => matches(doc, filter)),
  }),
  findOne: async (filter) =>
    collectionOf(name).find((doc) => matches(doc, filter)) ?? null,
  // What the index document is built out of — #334. The real one is
  // `countDocuments({ userId })` against the entry indexes, which is why the
  // index answers without assembling a list.
  countDocuments: async (filter) =>
    collectionOf(name).filter((doc) => matches(doc, filter)).length,
})

class MongoClient {
  async connect() {}
  db() {
    return { databaseName: 'memo', collection }
  }
}

/* Through the seam `db.js` leaves rather than by intercepting
   `require('mongodb')`; see the same note in stats.test.js and
   docs/module_system.md. */
const { useClient } = dependenciesInstalled ? await import('../utils/db/db.js') : {}

if (dependenciesInstalled) useClient(new MongoClient())

const exportRoute = dependenciesInstalled ? await import('../routes/export.js') : undefined

///////////////////////////////////////////////////////////////////////////////

/**
 * The handler, plus everything it wrote to the log while it ran. Both 404s
 * below are about which of the two a sentence came out of.
 *
 * `query` is how `?format=md` gets in — the route reads it out of
 * `queryStringParameters`, and `rawUrl` carries it too because that is what
 * Netlify hands a function. A Markdown body is returned as the string it is;
 * only a JSON one is parsed.
 */
const getExport = async (path, query = undefined) => {
  const logged = []
  const realError = console.error
  console.error = (...args) => logged.push(args.join(' '))

  const search = query ? `?${new URLSearchParams(query)}` : ''

  try {
    const response = await exportRoute.handler(
      {
        httpMethod: 'GET',
        path: `/.netlify/functions/export${path}`,
        rawUrl: `https://nil.moe/api/export${path}${search}`,
        headers: {},
        queryStringParameters: query ?? null,
        body: null,
      },
      {}
    )
    const isJson = (response.headers?.['content-type'] ?? '')
      .startsWith('application/json')
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body && isJson ? JSON.parse(response.body) : response.body,
      logged,
    }
  } finally {
    console.error = realError
  }
}

const seed = () => {
  store.users = [{ _id: 'a1', userId: 'u1', username: 'reader' }]
  store.filmEntries = [
    {
      _id: 'e1',
      userId: 'u1',
      workRef: 'w1',
      status: 'Watched',
      score: 8,
      updatedDate: 1700000000000,
    },
  ]
  store.films = [
    { _id: 'w1', entryType: 'Film', englishTranslatedTitle: 'A Film', releaseYear: 2001 },
  ]
  store.filmReviews = []
  store.tvShowEntries = []
  store.tvShows = []
  store.tvShowReviews = []
  store.gameEntries = []
  store.games = []
  store.gameReviews = []
  store.bookEntries = []
  store.books = []
  store.bookReviews = []
}

///////////////////////////////////////////////////////////////////////////////

/**
 * The four types spelled out rather than joined from `LIST_TYPES`. Derived
 * from the same list the controller interpolates, this would agree with the
 * controller instead of checking it — and what it is checking is that the
 * sentence reaches the caller at all.
 */
const TYPES_SENTENCE = 'no such list type; try one of films, tv, games, books'

test('an unknown list type is told which types would have worked', options, async () => {
  seed()

  const { statusCode, body } = await getExport('/nosuchtype/reader')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
  assert.equal(body.message, TYPES_SENTENCE)
})

test('an unknown username is told which name was not found', options, async () => {
  seed()

  const { statusCode, body } = await getExport('/nobody-has-this-name')

  assert.equal(statusCode, 404)
  assert.equal(body.error, 'NotFound')
  assert.equal(body.message, 'no such user: nobody-has-this-name')
})

test('neither 404 writes the caller a line in the function log', options, async () => {
  // Why both carry no `detail`. The name is a url segment of an
  // unauthenticated GET, so a `detail` there is one log line per request with
  // whatever a stranger sent in it — the write `findOneByFieldOrFail_`
  // refuses to make. The type sentence has no `detail` worth having either:
  // there is no exception here, only a url that named nothing.
  seed()

  const type = await getExport('/nosuchtype/reader')
  const user = await getExport('/whatever-a-stranger-typed')

  assert.deepEqual(type.logged, [])
  assert.deepEqual(user.logged, [])
})

test('a real user still gets their list, so the 404 above means something', options, async () => {
  // Without this, a db seam that found nobody would answer 404 for every name
  // and the "no such user" test would pass on a route that was wholly broken.
  seed()

  const { statusCode, body, logged } = await getExport('/films/reader')

  assert.equal(statusCode, 200)
  assert.equal(body.user, 'reader')
  assert.equal(body.lists.length, 1)
  assert.equal(body.lists[0].type, 'films')
  assert.equal(body.lists[0].count, 1)
  assert.equal(body.lists[0].entries[0].title, 'A Film')
  assert.deepEqual(logged, [])
})

/**
 * `_headers`' `/*` values, typed out rather than read from
 * `responses.SECURITY_HEADERS`. Spread from the constant these would agree
 * with whatever it holds, including holding nothing — the same reason
 * `TYPES_SENTENCE` above is spelled out instead of joined from `LIST_TYPES`.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

/**
 * #334's caching, written out here rather than spread from the controller's
 * constants for the reason `TYPES_SENTENCE` is. The numbers are the claim —
 * five minutes fresh, a day of serving a stored copy while it refreshes — and
 * a test that read them out of the file that sets them would agree with any
 * number at all, including the `no-cache` this replaced.
 */
const CACHE_HEADERS = {
  'cache-control': 'public, max-age=300',
  'netlify-cdn-cache-control':
    'public, durable, s-maxage=300, stale-while-revalidate=86400',
}

/** The same urls the index document carries, off a response that has a body. */
const LINK_HEADER = [
  '<https://nil.moe/api/export/reader>; rel="index"',
  '<https://nil.moe/api/export/films/reader>; rel="section"; title="Films"',
  '<https://nil.moe/api/export/tv/reader>; rel="section"; title="TV Shows"',
  '<https://nil.moe/api/export/games/reader>; rel="section"; title="Video Games"',
  '<https://nil.moe/api/export/books/reader>; rel="section"; title="Literature"',
].join(', ')

test('the JSON export carries the security headers, and still the CORS one', options, async () => {
  seed()

  const { statusCode, headers } = await getExport('/films/reader')

  assert.equal(statusCode, 200)
  assert.deepEqual(headers, {
    'content-type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    'access-control-allow-origin': '*',
    ...CACHE_HEADERS,
    link: LINK_HEADER,
  })
})

test('the Markdown export carries the same set', options, async () => {
  // The half a JSON assertion cannot reach. `?format=md` is answered by
  // `asText` with headers of its own, and `nosniff` is in that list because
  // this response and the one above come off the same url.
  seed()

  const { statusCode, headers, body } = await getExport('/films/reader', { format: 'md' })

  assert.equal(statusCode, 200)
  assert.equal(typeof body, 'string')
  assert.deepEqual(headers, {
    'content-type': 'text/markdown; charset=utf-8',
    ...SECURITY_HEADERS,
    'access-control-allow-origin': '*',
    ...CACHE_HEADERS,
    link: LINK_HEADER,
  })
})

test('a 404 off this route carries them too', options, async () => {
  // `asText` is the exception; everything else here is `responses.js`, and an
  // error is the response a stranger can ask for at will.
  seed()

  const { statusCode, headers } = await getExport('/nosuchtype/reader')

  assert.equal(statusCode, 404)
  assert.deepEqual(headers, {
    'content-type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  })
})

///////////////////////////////////////////////////////////////////////////////
// #334. `/api/export/:username` used to answer with all four lists in full —
// `nil`'s are 4.76 MB and took up to 9.5 seconds against a 10-second function
// timeout, which a caller sees as a dropped connection rather than a status.
// It answers with an index now, and `?limit=` is how you ask for entries.

test('the all-lists url answers an index rather than four lists', options, async () => {
  seed()

  const { statusCode, body } = await getExport('/reader')

  assert.equal(statusCode, 200)
  assert.equal(body.document, 'index')
  assert.deepEqual(
    body.lists.map(({ type, count, url }) => [type, count, url]),
    [
      ['films', 1, 'https://nil.moe/api/export/films/reader'],
      ['tv', 0, 'https://nil.moe/api/export/tv/reader'],
      ['games', 0, 'https://nil.moe/api/export/games/reader'],
      ['books', 0, 'https://nil.moe/api/export/books/reader'],
    ]
  )
  assert.equal(body.lists.every((list) => !('entries' in list)), true)
})

test('the count in the index is the count of the list the url it names serves', options, async () => {
  // The index is counted by the database and the list is assembled, so these
  // are two different code paths reporting the same number. An index whose
  // counts came from somewhere else would be worse than no index.
  seed()
  store.gameEntries = [
    { _id: 'g1', userId: 'u1', workRef: 'gw1', status: 'Completed', updatedDate: 2 },
    { _id: 'g2', userId: 'u1', workRef: 'gw2', status: 'Planned', updatedDate: 1 },
    // Somebody else's, which a count filtered on the wrong thing would include.
    { _id: 'g3', userId: 'u2', workRef: 'gw1', status: 'Completed', updatedDate: 3 },
  ]
  store.games = [{ _id: 'gw1', entryType: 'Game', englishTranslatedTitle: 'A Game' }]

  const index = await getExport('/reader')
  const list = await getExport('/games/reader')

  const counted = index.body.lists.find(({ type }) => type === 'games').count
  assert.equal(counted, 2)
  assert.equal(list.body.lists[0].count, 2)
})

test('a limit is still how you ask for every list at once', options, async () => {
  // The escape hatch, and the one the index's own note names. Without this the
  // change would have removed the all-in-one export rather than moved it.
  seed()

  const { statusCode, body } = await getExport('/reader', { limit: '200' })

  assert.equal(statusCode, 200)
  assert.ok(!('document' in body))
  assert.equal(body.lists.length, 4)
  assert.equal(body.lists[0].entries[0].title, 'A Film')
})

test('the index says how to ask for the entries it is not carrying', options, async () => {
  // #334's other half: `?limit=` and the per-type urls were named only in the
  // 413 body, which a caller reads once it has already failed.
  seed()

  const { body, headers } = await getExport('/reader')

  assert.match(body.note, /https:\/\/nil\.moe\/api\/export\/reader\?limit=N/)
  assert.equal(headers.link, LINK_HEADER)
})

test('the index is cached like any other export, and as Markdown too', options, async () => {
  seed()

  const json = await getExport('/reader')
  const markdown = await getExport('/reader', { format: 'md' })

  assert.equal(json.headers['cache-control'], CACHE_HEADERS['cache-control'])
  assert.equal(
    json.headers['netlify-cdn-cache-control'],
    CACHE_HEADERS['netlify-cdn-cache-control']
  )
  assert.equal(markdown.headers['content-type'], 'text/markdown; charset=utf-8')
  assert.match(markdown.body, /^- Films \(1\) — https:\/\/nil\.moe\/api\/export\/films\/reader$/m)
})

test('a 404 is not cached, whatever the lists are', options, async () => {
  // A name nobody has taken is not a document to keep for a day, and these
  // come off `responses.js` rather than `asText` — which is the reason, and
  // worth a test so that moving the headers into `responses.js` would fail
  // here rather than silently caching every typo.
  seed()

  const { headers } = await getExport('/nobody-has-this-name')

  assert.ok(!('cache-control' in headers))
  assert.ok(!('netlify-cdn-cache-control' in headers))
})

///////////////////////////////////////////////////////////////////////////////
// The CORS preflight — #334. `asText` has sent `access-control-allow-origin:
// *` since this route was written, with a comment saying that reading it from
// a page or a notebook should not need a proxy. `router.js` matches on verb,
// nothing matched OPTIONS, and `.otherwise` answered 404 — so the browser
// never sent the GET the header was there to permit.

const optionsExport = async (path) => {
  const response = await exportRoute.handler(
    {
      httpMethod: 'OPTIONS',
      path: `/.netlify/functions/export${path}`,
      rawUrl: `https://nil.moe/api/export${path}`,
      headers: {
        origin: 'https://example.org',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-something',
      },
      queryStringParameters: null,
      body: null,
    },
    {}
  )
  return { statusCode: response.statusCode, headers: response.headers, body: response.body }
}

test('a preflight is answered rather than 404ed', options, async () => {
  seed()

  for (const path of ['/reader', '/films/reader']) {
    const { statusCode } = await optionsExport(path)
    assert.equal(statusCode, 204, `OPTIONS ${path}`)
  }
})

test('the preflight permits the GET the route actually serves', options, async () => {
  seed()

  const { headers } = await optionsExport('/films/reader')

  assert.equal(headers['access-control-allow-origin'], '*')
  assert.match(headers['access-control-allow-methods'], /GET/)
  assert.equal(headers['access-control-allow-headers'], '*')
  assert.equal(headers['access-control-max-age'], '86400')
})

test('a preflight carries no body and no credentials grant', options, async () => {
  // 204 means there is nothing to read, and a wildcard origin alongside
  // `allow-credentials` is invalid per the spec — the browser would reject the
  // whole preflight rather than fall back.
  seed()

  const { body, headers } = await optionsExport('/reader')

  assert.equal(body, undefined)
  assert.ok(!('access-control-allow-credentials' in headers))
})

test('the preflight carries the site-wide security headers like every other response', options, async () => {
  seed()

  const { headers } = await optionsExport('/reader')

  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin')
})

test('a verb the route really does not serve is still a 404', options, async () => {
  // The control. Answering OPTIONS must not turn `.otherwise` into a
  // catch-all that accepts writes to a public read-only export.
  seed()

  const response = await exportRoute.handler(
    {
      httpMethod: 'DELETE',
      path: '/.netlify/functions/export/films/reader',
      rawUrl: 'https://nil.moe/api/export/films/reader',
      headers: {},
      queryStringParameters: null,
      body: null,
    },
    {}
  )

  assert.equal(response.statusCode, 404)
})
