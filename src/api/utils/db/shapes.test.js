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

  assert.deepEqual(work, ghostKiller)
  assert.equal(entry._id, 'e1')
  assert.equal(entry.workRef, 'w1')
  // The caller spreads the entry into the row alongside `commonMetadata`, so a
  // `work` left here would be the same document a second time.
  assert.equal('work' in entry, false)
})

test('both halves are documents, with nothing wrapped around either', () => {
  const { entry, work } = toEntryWithMetadata(row('e1', [ghostKiller]), 'Film')

  // The caller spreads `entry` and returns `work` as `commonMetadata`, so a
  // `data` on either would be read straight through to the page as a field of
  // that name. `_id` is the id, and the only one.
  assert.equal('data' in entry, false)
  assert.equal('ref' in entry, false)
  assert.equal('data' in work, false)
})

test('an entry whose work is missing still knows what type it is', () => {
  const { work } = toEntryWithMetadata(row('e1', []), 'Film')

  // The page reads `commonMetadata.entryType` off this.
  assert.deepEqual(work, { entryType: 'Film' })
})

test('the stand-in is built per row rather than shared between them', () => {
  const first = toEntryWithMetadata(row('e1', []), 'Game')
  const second = toEntryWithMetadata(row('e2', []), 'Game')

  first.work.englishTranslatedTitle = 'set by a caller'
  assert.deepEqual(second.work, { entryType: 'Game' })
})

test('an entry that lost its work keeps everything the entry itself recorded', () => {
  const { entry } = toEntryWithMetadata(row('e1', []), 'Book')

  assert.equal(entry.score, 6)
  assert.equal(entry.status, 'Completed')
  assert.equal(entry.workRef, 'w-that-is-gone')
})
