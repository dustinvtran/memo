import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addedDateOf, toSnapshot, changedFields, hasChanges, toVersionList, revisionsToPrune } from './revision_history.js'
test('a snapshot keeps the fields the user edits, and the review with them', () => {
  const entry = {
    _id: 'e1',
    userId: 'u1',
    status: 'Completed',
    score: 9,
    completedDate: 1700000000000,
    workRef: 'w1',
    updatedDate: 1700000001000,
  }

  assert.deepEqual(toSnapshot(entry, 'A long note.'), {
    status: 'Completed',
    score: 9,
    completedDate: 1700000000000,
    workRef: 'w1',
    review: 'A long note.',
  })
})

test('a snapshot drops the overrides the form left empty', () => {
  const snapshot = toSnapshot({
    status: 'Planned',
    overrides: { englishTranslatedTitle: 'Stalker', genres: null, actors: [] },
  })

  assert.deepEqual(snapshot.overrides, { englishTranslatedTitle: 'Stalker' })
})

test('an unchanged save records no change', () => {
  const before = { status: 'Completed', score: 8, review: 'Good.' }
  const after = { status: 'Completed', score: 8, review: 'Good.' }

  assert.deepEqual(changedFields(before, after), [])
  assert.equal(hasChanges(before, after), false)
})

test('null, undefined and empty are the same absence', () => {
  assert.deepEqual(changedFields({ score: null }, {}), [])
  assert.deepEqual(changedFields({ review: '' }, { review: undefined }), [])
  assert.deepEqual(changedFields({ progress: undefined }, { progress: null }), [])
})

test('the fields that changed are reported, and nothing else', () => {
  const before = { status: 'InProgress', score: 7, review: 'Halfway.' }
  const after = { status: 'Completed', score: 7, review: 'Finished it.' }

  assert.deepEqual(changedFields(before, after), ['status', 'review'])
})

test('a wiped review is a change, which is the whole point', () => {
  assert.deepEqual(changedFields({ review: 'A long note.' }, { review: '' }), [
    'review',
  ])
})

test('an edited override is reported by name', () => {
  const before = { overrides: { englishTranslatedTitle: 'Stalker', duration: 162 } }
  const after = { overrides: { englishTranslatedTitle: 'Сталкер', duration: 162 } }

  assert.deepEqual(changedFields(before, after), [
    'overrides.englishTranslatedTitle',
  ])
})

test('a reordered list is a change, a reordered object is not', () => {
  assert.deepEqual(
    changedFields(
      { overrides: { genres: ['Sci-Fi', 'Drama'] } },
      { overrides: { genres: ['Drama', 'Sci-Fi'] } }
    ),
    ['overrides.genres']
  )
  assert.deepEqual(
    changedFields(
      { overrides: { genres: ['Drama'], duration: 162 } },
      { overrides: { duration: 162, genres: ['Drama'] } }
    ),
    []
  )
})

test('the version list is newest first and says what each version changed', () => {
  const versions = toVersionList(
    { id: 'current', createdDate: 300, snapshot: { status: 'Completed', score: 9 } },
    [
      { id: 'r1', createdDate: 100, snapshot: { status: 'Planned' } },
      { id: 'r2', createdDate: 200, snapshot: { status: 'InProgress' } },
    ]
  )

  assert.deepEqual(
    versions.map(({ id, isCurrent, changes }) => ({ id, isCurrent, changes })),
    [
      { id: 'current', isCurrent: true, changes: ['status', 'score'] },
      { id: 'r2', isCurrent: false, changes: ['status'] },
      // Nothing is known about what came before the oldest version we hold.
      { id: 'r1', isCurrent: false, changes: [] },
    ]
  )
})

test('an entry with no history at all is just its current version', () => {
  const versions = toVersionList(
    { id: 'current', createdDate: 1, snapshot: { status: 'Planned' } },
    []
  )

  assert.deepEqual(versions, [
    {
      id: 'current',
      createdDate: 1,
      snapshot: { status: 'Planned' },
      isCurrent: true,
      isOriginal: false,
      changes: [],
    },
  ])
})

test('pruning keeps the newest versions and the oldest, and drops between', () => {
  const revisions = [
    { _id: 'oldest', createdDate: 1 },
    { _id: 'newest', createdDate: 4 },
    { _id: 'middle', createdDate: 2 },
    { _id: 'newer', createdDate: 3 },
  ]

  assert.deepEqual(revisionsToPrune(revisions, 3), ['middle'])
  assert.deepEqual(revisionsToPrune(revisions, 2), ['newer', 'middle'])
  assert.deepEqual(revisionsToPrune(revisions, 4), [])
  assert.deepEqual(revisionsToPrune(revisions, 50), [])
})

test('an entry was added in the second its ObjectId was minted', () => {
  // 0x6500e8c0 is 1694558400, 2023-09-12T22:40:00Z.
  assert.equal(addedDateOf('6500e8c0aaaaaaaaaaaaaaaa'), 1694558400000)
  assert.equal(addedDateOf({ toString: () => '6500e8c0aaaaaaaaaaaaaaaa' }), 1694558400000)
})

test('an id that is not an ObjectId has no added date', () => {
  assert.equal(addedDateOf('e1'), null)
  assert.equal(addedDateOf(undefined), null)
  assert.equal(addedDateOf('6500e8c0aaaaaaaaaaaaaaaaaa'), null)
})

test('the oldest version is the original when it dates from the moment of adding', () => {
  const added = 1694558400000
  const versions = toVersionList(
    { id: 'current', createdDate: added + 90000, snapshot: { status: 'Completed' } },
    // `updatedDate` is stamped just before the insert, the id just after, and
    // the id only counts whole seconds.
    [{ id: 'r1', createdDate: added + 420, snapshot: { status: 'Planned' } }],
    added
  )

  assert.deepEqual(
    versions.map(({ id, isOriginal }) => ({ id, isOriginal })),
    [
      { id: 'current', isOriginal: false },
      { id: 'r1', isOriginal: true },
    ]
  )
})

test('an entry never edited is its own original', () => {
  const added = 1694558400000
  const [only] = toVersionList(
    { id: 'current', createdDate: added + 1, snapshot: { status: 'Planned' } },
    [],
    added
  )

  assert.equal(only.isCurrent, true)
  assert.equal(only.isOriginal, true)
})

test('a history that begins after the entry was added has no original', () => {
  const added = 1694558400000
  const versions = toVersionList(
    { id: 'current', createdDate: added + 2e9, snapshot: { status: 'Completed' } },
    [{ id: 'r1', createdDate: added + 1e9, snapshot: { status: 'InProgress' } }],
    added
  )
  assert.deepEqual(versions.map(({ isOriginal }) => isOriginal), [false, false])

  // No date on the version is no evidence either way.
  const [undated] = toVersionList({ id: 'current', snapshot: {} }, [], added)
  assert.equal(undated.isOriginal, false)
})
