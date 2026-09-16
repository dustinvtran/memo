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
const ok = (entry) => assert.equal(impossibleStateReason(entry), undefined)
const refused = (entry, match) => {
  const reason = impossibleStateReason(entry)
  assert.ok(reason, `expected a refusal for ${JSON.stringify(entry)}`)
  assert.match(reason, match)
}

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
