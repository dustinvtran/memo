const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  toSnapshot,
  changedFields,
  hasChanges,
  toVersionList,
  revisionsToPrune,
} = require('./revision_history')

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
      changes: [],
    },
  ])
})

test('pruning keeps the newest versions and drops the rest', () => {
  const revisions = [
    { _id: 'oldest', createdDate: 1 },
    { _id: 'newest', createdDate: 3 },
    { _id: 'middle', createdDate: 2 },
  ]

  assert.deepEqual(revisionsToPrune(revisions, 2), ['oldest'])
  assert.deepEqual(revisionsToPrune(revisions, 3), [])
  assert.deepEqual(revisionsToPrune(revisions, 50), [])
})
