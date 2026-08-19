const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  WORK_TYPES,
  TYPES,
  byType,
  byEntryCollection,
  parseRef,
} = require('./work_types')

/**
 * Refs the works collections really hold: Inception, Breaking Bad, Grand Theft
 * Auto V, The Passage, and an ISBN-10 whose check digit is an X — the one
 * spelling of a book ref that is not all digits.
 */
const REAL_REFS = {
  films: ['27205'],
  tv: ['1396'],
  games: ['1020'],
  books: ['9780385669528', '404387801X'],
}

test('every type round-trips segment -> entry collection -> segment', () => {
  for (const type of TYPES) {
    const entryCollection = byType(type)?.entries
    assert.ok(entryCollection, `no entry collection for ${type}`)
    assert.equal(byEntryCollection(entryCollection)?.type, type)
  }
})

test('an unknown segment, and an unknown collection, are simply absent', () => {
  assert.equal(byType('albums'), undefined)
  assert.equal(byType(''), undefined)
  // Not an entry collection, so it must not answer to one — the works and the
  // reviews live in their own collections.
  assert.equal(byEntryCollection('films'), undefined)
  assert.equal(byEntryCollection('filmReviews'), undefined)
})

test('the four types the site has, under the collections it stores them in', () => {
  assert.deepEqual(TYPES, ['films', 'tv', 'games', 'books'])

  assert.deepEqual(byType('tv'), {
    type: 'tv',
    works: 'tvShows',
    entries: 'tvShowEntries',
    reviews: 'tvShowReviews',
    entryType: 'TVShow',
    apiRefPrefixes: ['tmdb'],
    identityPrefixes: ['tmdb'],
    refShape: 'id',
  })
})

test('a review collection is its entry collection with Entries swapped out', () => {
  // The rule the string surgery in controllers/utils.js used to encode. It
  // holds for all four, which is why the table can be trusted to replace it.
  for (const workType of WORK_TYPES) {
    assert.equal(workType.reviews, workType.entries.replace('Entries', 'Reviews'))
  }
})

test('nothing is named twice, so the lookups cannot collide', () => {
  for (const field of ['type', 'works', 'entries', 'reviews', 'entryType']) {
    const values = WORK_TYPES.map((workType) => workType[field])
    assert.equal(new Set(values).size, values.length, `duplicate ${field}`)
  }
})

test('every row is complete', () => {
  for (const workType of WORK_TYPES) {
    for (const field of ['type', 'works', 'entries', 'reviews', 'entryType']) {
      assert.equal(typeof workType[field], 'string', `${workType.type} has no ${field}`)
    }
    assert.ok(workType.apiRefPrefixes.length > 0, `${workType.type} has no apiRefPrefixes`)
    assert.ok(workType.identityPrefixes.length > 0, `${workType.type} has no identityPrefixes`)
  }
})

test('the legacy and secondary apiRef prefixes are still carried', () => {
  // 775 games carry an `hltb` ref alongside their `igdb` one, and some books
  // are cached under `google__` rather than `ISBN__`. Dropping either from the
  // table would make those works uncacheable.
  assert.deepEqual(byType('games')?.apiRefPrefixes, ['igdb', 'hltb'])
  assert.deepEqual(byType('books')?.apiRefPrefixes, ['ISBN', 'google'])
})

test('only the prefixes that name the work establish identity', () => {
  // The distinction the works controller looks a work up by. An hltb id is a
  // page id, not a game id, so `hltb` is carried but never looked up by —
  // whereas `google__` and `ISBN__` both mean the same ISBN.
  assert.deepEqual(byType('games')?.identityPrefixes, ['igdb'])
  assert.deepEqual(byType('books')?.identityPrefixes, ['ISBN', 'google'])

  for (const workType of WORK_TYPES) {
    for (const prefix of workType.identityPrefixes) {
      assert.ok(
        workType.apiRefPrefixes.includes(prefix),
        `${workType.type} identifies by ${prefix} but never carries it`
      )
    }
  }
})

test('a ref the collections hold is accepted, and comes back as it went in', () => {
  // Unchanged rather than parsed into a number: the lookups build
  // `${prefix}__${ref}` out of it and the adapters send it on as it is.
  for (const [type, refs] of Object.entries(REAL_REFS)) {
    for (const ref of refs) {
      assert.equal(parseRef(type, ref), ref, `${type} rejected its own ref ${ref}`)
    }
  }
})

test('every type can name a ref, so no type is unreachable', () => {
  // A row whose refShape nothing answers to would 404 every retrieve of that
  // type, which is what the `?.` in parseRef would otherwise do in silence.
  for (const workType of WORK_TYPES) {
    assert.ok(REAL_REFS[workType.type], `no sample ref for ${workType.type}`)
    assert.ok(
      parseRef(workType.type, REAL_REFS[workType.type][0]),
      `${workType.type} accepts no ref at all`
    )
  }
})

test('an id is a positive integer and nothing else', () => {
  for (const type of ['films', 'tv', 'games']) {
    // What the igdb adapter would otherwise interpolate into `where id = ...`.
    assert.equal(parseRef(type, '1020; drop'), undefined)
    assert.equal(parseRef(type, '1020 | 1021'), undefined)
    assert.equal(parseRef(type, '*'), undefined)
    assert.equal(parseRef(type, 'id = 1020'), undefined)
    // A `$` on its own would accept these two: it matches before a trailing
    // newline as well as at the end, and `%0A` in the url is how a newline
    // gets here.
    assert.equal(parseRef(type, '1020\n'), undefined)
    assert.equal(parseRef(type, '1020\nname = "x"'), undefined)

    assert.equal(parseRef(type, ''), undefined)
    assert.equal(parseRef(type, ' 1020'), undefined)
    assert.equal(parseRef(type, '1020 '), undefined)
    assert.equal(parseRef(type, '-1'), undefined)
    assert.equal(parseRef(type, '1e3'), undefined)
    assert.equal(parseRef(type, '10.20'), undefined)
    // No id is zero and none is written with a leading zero, so accepting one
    // would look a work up under a name nothing caches it under.
    assert.equal(parseRef(type, '0'), undefined)
    assert.equal(parseRef(type, '01020'), undefined)
  }
})

test('a book ref is an ISBN, unpunctuated', () => {
  // The Google Books adapter interpolates this into a url carrying
  // GOOGLE_API_KEY, so an `&` here is query parameters of the caller's
  // choosing on a request of ours.
  assert.equal(parseRef('books', '9780385669528&key=theirs'), undefined)
  assert.equal(parseRef('books', '9780385669528?maxResults=1'), undefined)

  // Neither length is optional, and the check digit is the only letter.
  assert.equal(parseRef('books', '978038566952'), undefined)
  assert.equal(parseRef('books', '97803856695281'), undefined)
  assert.equal(parseRef('books', 'X04387801X'), undefined)
  // Lowercase is refused rather than upcased: every book is cached under the
  // uppercase spelling Google Books hands out, so accepting the other one
  // would miss the cache and store the same book a second time.
  assert.equal(parseRef('books', '404387801x'), undefined)
  // The same ISBN as The Passage's, but not the way anything holds it.
  assert.equal(parseRef('books', '978-0-385-66952-8'), undefined)
})

test('a type with no refs of its own accepts nothing', () => {
  // The 404 an unknown `:type` segment already gets, reached by the same route
  // as a malformed ref rather than by a check of its own.
  assert.equal(parseRef('albums', '1020'), undefined)
  assert.equal(parseRef('', '1020'), undefined)
  // Not a type — and, since both lookups go through an object, not a way to
  // reach anything else either.
  assert.equal(parseRef('constructor', '1020'), undefined)
  assert.equal(parseRef('__proto__', '1020'), undefined)
})
