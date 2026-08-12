const { test } = require('node:test')
const assert = require('node:assert/strict')

const { toSameFormatAsFaunaDb, toEntryWithMetadata } = require('./shapes')

/**
 * One row of the list aggregate: the entry document, with `$lookup`'s array of
 * matched works on it.
 * @type {(id: string, work: object[]) => object}
 */
const row = (id, work) => ({
  _id: id,
  workRef: work[0]?._id ?? 'w-that-is-gone',
  status: 'Completed',
  score: 6,
  updatedDate: 1786336961244,
  work,
})

const ghostKiller = {
  _id: 'w1',
  entryType: 'Film',
  englishTranslatedTitle: 'Ghost Killer',
  releaseYear: 2025,
}

test('a document is wrapped with its id where a fauna ref used to be', () => {
  assert.deepEqual(toSameFormatAsFaunaDb({ _id: 'e1', score: 6 }), {
    data: { _id: 'e1', score: 6 },
    ref: { id: 'e1' },
  })
})

test('the joined work comes back beside the entry, not on it', () => {
  const { entry, work } = toEntryWithMetadata(row('e1', [ghostKiller]), 'Film')

  assert.deepEqual(work.data, ghostKiller)
  assert.equal(entry.ref.id, 'e1')
  assert.equal(entry.data.workRef, 'w1')
  // The caller spreads the entry into the row alongside `commonMetadata`, so a
  // `work` left here would be the same document a second time.
  assert.equal('work' in entry.data, false)
})

test('an entry whose work is missing still knows what type it is', () => {
  const { work } = toEntryWithMetadata(row('e1', []), 'Film')

  // The shape a found work has, not a wrapped one: this becomes
  // `commonMetadata`, and the page reads `commonMetadata.entryType` off it.
  assert.deepEqual(work.data, { entryType: 'Film' })
  assert.equal(work.data.entryType, 'Film')
  assert.equal('data' in work.data, false)
})

test('the stand-in is built per row rather than shared between them', () => {
  const first = toEntryWithMetadata(row('e1', []), 'Game')
  const second = toEntryWithMetadata(row('e2', []), 'Game')

  first.work.data.englishTranslatedTitle = 'set by a caller'
  assert.deepEqual(second.work.data, { entryType: 'Game' })
})

test('an entry that lost its work keeps everything the entry itself recorded', () => {
  const { entry } = toEntryWithMetadata(row('e1', []), 'Book')

  assert.equal(entry.data.score, 6)
  assert.equal(entry.data.status, 'Completed')
  assert.equal(entry.data.workRef, 'w-that-is-gone')
})
