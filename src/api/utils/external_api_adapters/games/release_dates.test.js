const { test } = require('node:test')
const assert = require('node:assert/strict')

const { earliestReleaseDate } = require('./release_dates')

/** Dates as IGDB sends them: unix seconds, in no particular order. */
const threePlatforms = [
  { id: 2, date: 1101772800, platform: 8 },
  { id: 1, date: 1099958400, platform: 6 },
  { id: 3, date: 1104537600, platform: 9 },
]

test('the earliest of several release dates wins', () => {
  assert.equal(earliestReleaseDate(threePlatforms), 1099958400)
})

test('IGDB\'s array is left in the order it arrived in', () => {
  // `sort` reorders in place. Handing a response back rearranged is the kind
  // of thing that is harmless until something downstream reads it again.
  const dates = [...threePlatforms]
  earliestReleaseDate(dates)

  assert.deepEqual(dates, threePlatforms)
})

test('a game with no release dates has no date rather than throwing', () => {
  // An unannounced game has no key at all; some others carry an empty array.
  // The second of these is what 500'd — the optional chain covered the key
  // and the unguarded [0] did not cover the empty array.
  assert.equal(earliestReleaseDate(undefined), undefined)
  assert.equal(earliestReleaseDate([]), undefined)
  assert.equal(earliestReleaseDate(null), undefined)
})

test('entries IGDB has no date for are skipped, not sorted to the front', () => {
  assert.equal(earliestReleaseDate([{ id: 1, platform: 6 }]), undefined)
  assert.equal(
    earliestReleaseDate([{ id: 1, platform: 6 }, { id: 2, date: 1099958400 }]),
    1099958400,
  )
  assert.equal(earliestReleaseDate([{ date: null }, { date: '1099958400' }]), undefined)
})

test('dates sort by value, not as strings', () => {
  // The default comparator would put 1000000000 before 999999999.
  assert.equal(earliestReleaseDate([{ date: 1000000000 }, { date: 999999999 }]), 999999999)
})

test('a single release date is its own earliest', () => {
  assert.equal(earliestReleaseDate([{ date: 1099958400 }]), 1099958400)
})

test('something that is not a list at all is no date', () => {
  assert.equal(earliestReleaseDate({ date: 1099958400 }), undefined)
})
