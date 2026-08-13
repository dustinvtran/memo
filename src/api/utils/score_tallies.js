/**
 * @file What a score histogram is, and how the database's count of one becomes
 * the shape that gets stored and drawn.
 *
 * The counting is the database's job — `{ $group: { _id: '$score' } }` over the
 * user's entries, which is at most eleven rows instead of several hundred
 * documents. But a `$group` returns a row only for a score somebody actually
 * used, and the stored shape is not optional: `scoreTallyParser` in
 * parsers/users.js requires all eleven keys and requires every one of them to
 * be a number, so a user with nothing rated 1 would fail validation on the way
 * into `users`. The chart draws a bar per score either way, and reads
 * `undefined` for the missing one.
 *
 * So the buckets nobody filled are filled with zeros here, which is also the
 * only interesting thing that happens between the query and the write.
 * Deliberately pure and dependency-free (no zod, no ramda, no database), so it
 * is covered by `node --test` without an install — see score_tallies.test.js.
 */

/** The scores a user can give. `unrated` is the twelfth thing an entry can be. */
const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

const UNRATED = 'unrated'

/**
 * Every key `scoreTallyParser` requires, in the order the chart reads them.
 * @type {string[]}
 */
const SCORE_TALLY_KEYS = [...SCORES.map(String), UNRATED]

/**
 * The `{ _id, count }` rows of a `$group` on `$score`, as a tally.
 *
 * `_id` is `null` for an entry with no score: Mongo groups a field that is
 * missing together with one that is explicitly `null`, and both are what the
 * form writes for "not rated yet". They are one bucket here for the same
 * reason they were one before — `getTallyOfScore(undefined, …)` compared with
 * `==`, which matches both.
 *
 * A score that is not one of the eleven buckets is counted nowhere, which is
 * again what loose equality did with it. Nothing in the database has one
 * today: every score stored across the four entry collections is a BSON int
 * from 1 to 10, or null, or absent. The rule matters anyway, because the
 * alternative is a key the parser rejects — one bad document would cost every
 * user on that collection their stats, rather than costing that entry its
 * place in the histogram.
 *
 * @type {(groups?: { _id: any, count: number }[]) => Record<string, number>}
 */
const toScoreTally = (groups) =>
  (groups ?? []).reduce((tally, { _id, count }) => {
    const bucket = toBucket(_id)
    return bucket in tally
      ? { ...tally, [bucket]: tally[bucket] + toCount(count) }
      : tally
  }, emptyScoreTally())

/**
 * All eleven keys at zero. Built fresh each time: it is spread into and handed
 * out, and a shared one would carry the last user's numbers into the next.
 * @type {() => Record<string, number>}
 */
const emptyScoreTally = () =>
  Object.fromEntries(SCORE_TALLY_KEYS.map((key) => [key, 0]))

module.exports = {
  SCORE_TALLY_KEYS,
  toScoreTally,
  emptyScoreTally,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * Keys are strings, so `7` and `'7'` are the same bucket — as they were when
 * the tally matched them with `==`.
 */
const toBucket = (id) =>
  id === null || id === undefined ? UNRATED : String(id)

/** A `$sum` is a number; anything else counts as nothing rather than as NaN. */
const toCount = (count) => (Number.isFinite(count) ? count : 0)
