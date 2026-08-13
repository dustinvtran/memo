const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  SCORE_TALLY_KEYS,
  toScoreTally,
  emptyScoreTally,
} = require('./score_tallies')

/** What `scoreTallyParser` in parsers/users.js accepts, checked here without zod. */
const isValidTally = (tally) =>
  SCORE_TALLY_KEYS.every((key) => typeof tally[key] === 'number') &&
  Object.keys(tally).length === SCORE_TALLY_KEYS.length

test('the eleven keys the parser requires, and no others', () => {
  assert.deepEqual(Object.keys(emptyScoreTally()), [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'unrated',
  ])
})

test('the scores nobody used are zeros, not absences', () => {
  // The whole point: a `$group` returns a row per score that occurs, so a user
  // with only 7s and 8s gets two rows back, and the other nine keys have to
  // come from somewhere or `users` fails validation on the way in.
  const tally = toScoreTally([
    { _id: 7, count: 12 },
    { _id: 8, count: 3 },
  ])

  assert.equal(isValidTally(tally), true)
  assert.deepEqual(tally, {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
    7: 12, 8: 3, 9: 0, 10: 0, unrated: 0,
  })
})

test('a user with nothing at all is eleven zeros, not an empty object', () => {
  assert.deepEqual(toScoreTally([]), emptyScoreTally())
  assert.equal(isValidTally(toScoreTally([])), true)
  // `undefined` reaches this only if a caller drops the rows, but eleven zeros
  // is a better answer than a crash inside a reduce.
  assert.deepEqual(toScoreTally(), emptyScoreTally())
})

test('an unscored entry lands in unrated, whether the field is null or absent', () => {
  // Mongo groups a missing `score` with an explicit `null` under one `_id:
  // null`, which is the bucket `getTallyOfScore(undefined, …)` counted with
  // `==`. Both spellings are asserted in case that is ever grouped separately.
  assert.equal(toScoreTally([{ _id: null, count: 9 }]).unrated, 9)
  assert.equal(toScoreTally([{ _id: undefined, count: 9 }]).unrated, 9)
})

test('a score stored as a string counts with its number', () => {
  // `e.data.score == 7` matched a `'7'`, so this has to as well. Nothing in the
  // database holds one today; a bucket that silently split would be a user's
  // histogram quietly changing.
  assert.equal(toScoreTally([{ _id: 7, count: 2 }, { _id: '7', count: 3 }])[7], 5)
})

test('a score outside the eleven buckets is dropped, not made into a key', () => {
  // `0`, `11` and `3.5` matched no bucket under `==` either. What matters is
  // that they do not reach the parser as keys: `scoreTallyParser` is strict,
  // and one odd document would cost a user their stats for that whole
  // collection rather than cost that entry its bar.
  const tally = toScoreTally([
    { _id: 0, count: 1 },
    { _id: 11, count: 1 },
    { _id: 3.5, count: 1 },
    { _id: 'nonsense', count: 1 },
    { _id: 5, count: 4 },
  ])

  assert.equal(isValidTally(tally), true)
  assert.deepEqual(tally, {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 4, 6: 0,
    7: 0, 8: 0, 9: 0, 10: 0, unrated: 0,
  })
})

test('every score used gives the count the database counted', () => {
  const tally = toScoreTally(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((score) => ({
      _id: score,
      count: score * 2,
    }))
  )

  assert.deepEqual(tally, {
    1: 2, 2: 4, 3: 6, 4: 8, 5: 10, 6: 12,
    7: 14, 8: 16, 9: 18, 10: 20, unrated: 0,
  })
})

test('a count that is not a number does not become NaN', () => {
  // A NaN passes `typeof x === 'number'` and so passes the parser, and then
  // renders as a blank bar and poisons the mean and the standard deviation
  // the profile computes from the whole tally.
  const tally = toScoreTally([{ _id: 4, count: undefined }, { _id: 4, count: 2 }])

  assert.equal(tally[4], 2)
  assert.equal(Object.values(tally).some(Number.isNaN), false)
})

test('a fresh tally each time, so one user cannot carry into the next', () => {
  const first = toScoreTally([{ _id: 6, count: 5 }])
  first[6] = 999

  assert.equal(toScoreTally([{ _id: 6, count: 5 }])[6], 5)
  assert.equal(emptyScoreTally()[6], 0)
})
