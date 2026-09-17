/**
 * @file The entry-state rules, on their own, with no database and no parser.
 *
 * Every case here is one the audit actually found in production, which is why
 * the fixtures read like a list of grievances rather than like a matrix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { impossibleStateReason } from './entry_state.js'

const DAY = 86400000
const ok = (entry, work) => assert.equal(impossibleStateReason(entry, work), undefined)
const refused = (entry, match, work) => {
  const reason = impossibleStateReason(entry, work)
  assert.ok(reason, `expected a refusal for ${JSON.stringify(entry)}`)
  assert.match(reason, match)
}

/** A year as the timestamp an entry stores. */
const on = (iso) => Date.parse(iso)

test('a Planned entry may not carry a date or a progress', () => {
  refused({ status: 'Planned', completedDate: 1700000000000 }, /Planned .* completed date/)
  refused({ status: 'Planned', startedDate: 1700000000000 }, /Planned .* started date/)
  refused({ status: 'Planned', progress: 7 }, /Planned .* progress/)
})

/**
 * 18 films were saved inside one five-minute window in 2023 carrying that
 * day's date as a `completedDate`, which is what a watchlist add used to write.
 * All three complaints in one sentence, because they are one mistake.
 */
test('a Planned entry carrying all three says so once', () => {
  refused(
    { status: 'Planned', startedDate: 1, completedDate: 2, progress: 3 },
    /a started date, a completed date and progress/
  )
})

test('a Dropped entry may not carry a completed date', () => {
  refused({ status: 'Dropped', completedDate: 1700000000000 }, /Dropped .* completed date/)
})

/** Dropped keeps its started date and its progress — you did begin it. */
test('a Dropped entry keeps what it is allowed to keep', () => {
  ok({ status: 'Dropped', startedDate: 1700000000000, progress: 12 })
})

test('a Completed entry needs a completed date', () => {
  refused({ status: 'Completed', score: 7 }, /Completed .* needs a completed date/)
  refused({ status: 'Completed', completedDate: null }, /needs a completed date/)
})

test('a completed date before its started date is refused', () => {
  refused(
    { status: 'Completed', startedDate: 1700000000000, completedDate: 1700000000000 - DAY },
    /completed date is before the started date/
  )
})

/** The commonest shape in this database: finished the day you started. */
test('the same day for both is fine', () => {
  ok({ status: 'Completed', startedDate: 1700000000000, completedDate: 1700000000000 })
})

test('a started date with no completed date is fine while in progress', () => {
  ok({ status: 'InProgress', startedDate: 1700000000000, progress: 3 })
})

/**
 * `null` and absent mean the same thing everywhere else in this codebase and
 * they have to here too — the documents store `null` where a date was cleared,
 * and a partial update omits what it is not changing.
 */
test('null and absent are the same absence', () => {
  ok({ status: 'Planned' })
  ok({ status: 'Planned', startedDate: null, completedDate: null, progress: null })
})

test('a status with no rules of its own is left alone', () => {
  ok({ status: 'InProgress' })
  ok({})
  ok(undefined)
})

///////////////////////////////////////////////////////////////////////////////
// #361: a date before the work came out.

const spongebob = { englishTranslatedTitle: 'SpongeBob SquarePants', releaseYear: 1999 }

test('a date before the work came out is refused, and says both ways out', () => {
  refused(
    { status: 'Completed', completedDate: on('1997-12-31') },
    /completed date of 1997 is before "SpongeBob SquarePants" came out in 1999/,
    spongebob
  )
  refused(
    { status: 'Completed', startedDate: on('1997-12-31'), completedDate: on('2000-01-02') },
    /started date of 1997 is before/,
    spongebob
  )
  // The message has to name the repair, because the field to change may be
  // either one and only its owner knows which.
  refused(
    { status: 'Completed', completedDate: on('1997-12-31') },
    /move the date, or override the release year/,
    spongebob
  )
})

test('a date in the release year itself is fine', () => {
  ok({ status: 'Completed', completedDate: on('1999-01-01') }, spongebob)
  ok({ status: 'Completed', completedDate: on('2015-06-01') }, spongebob)
})

/**
 * The override is the point of the rule rather than an exception to it. A game
 * in early access is playable years before the release the databases record,
 * and saying so is the repair — so measuring against the work anyway would
 * refuse the very correction that fixes it.
 */
test("the entry's own release year wins over the work's", () => {
  const slayTheSpire = { englishTranslatedTitle: 'Slay the Spire', releaseYear: 2019 }
  const played = { status: 'Completed', startedDate: on('2018-09-08'), completedDate: on('2018-09-13') }

  refused(played, /before "Slay the Spire" came out in 2019/, slayTheSpire)
  ok({ ...played, overrides: { releaseYear: 2017 } }, slayTheSpire)
})

test('an override later than the work is still the year measured against', () => {
  refused(
    { status: 'Completed', completedDate: on('2000-06-01'), overrides: { releaseYear: 2005 } },
    /came out in 2005/,
    spongebob
  )
})

test('a work with no release year has nothing to be before', () => {
  ok({ status: 'Completed', completedDate: on('1900-01-01') }, { englishTranslatedTitle: 'A Film' })
  ok({ status: 'Completed', completedDate: on('1900-01-01') }, {})
})

/**
 * A caller that did not look up the work passes `undefined`, and both of the
 * rules that need one are skipped. Collapsing that with "looked and found
 * nothing" would tell every such caller its entry was broken.
 */
test('a caller with no work in hand is not told its entry is broken', () => {
  ok({ status: 'Completed', completedDate: on('1900-01-01'), workRef: 'w1' })
  ok({ status: 'Completed', completedDate: on('1900-01-01'), workRef: 'w1' }, undefined)
})

test('an entry with no work of its own is never measured', () => {
  ok({ status: 'Completed', completedDate: on('1900-01-01'), overrides: { englishTranslatedTitle: 'x' } })
})

///////////////////////////////////////////////////////////////////////////////
// A workRef naming nothing.

test('a workRef that names nothing is refused', () => {
  refused({ status: 'Planned', workRef: 'w9' }, /points at a work \(w9\) that does not exist/, null)
})

test('no workRef at all is not a dangling one', () => {
  ok({ status: 'Planned' }, null)
  ok({ status: 'Planned', workRef: '' }, null)
})

///////////////////////////////////////////////////////////////////////////////
// InProgress.

test('an InProgress entry has not been completed', () => {
  refused({ status: 'InProgress', completedDate: on('2020-01-01') }, /InProgress entry cannot have a completed date/)
  ok({ status: 'InProgress', startedDate: on('2020-01-01') })
})

test('the article agrees with the status it names', () => {
  refused({ status: 'InProgress', completedDate: 1 }, /^an InProgress/)
  refused({ status: 'Planned', completedDate: 1 }, /^a Planned/)
})
