const { test } = require('node:test')
const assert = require('node:assert/strict')

const { WORK_TYPES, TYPES, byType, byEntryCollection } = require('./work_types')

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
