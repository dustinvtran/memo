const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  toUserEntriesPipeline,
  toScoreTallyPipeline,
  toFindOptions,
} = require('./queries')

const stageNames = (pipeline) => pipeline.map((stage) => Object.keys(stage)[0])

const stage = (pipeline, name) =>
  pipeline.find((stage) => Object.keys(stage)[0] === name)?.[name]

const filmsOf = (userId, limit) =>
  toUserEntriesPipeline({ userId, workCollection: 'films', limit })

test('a list is matched, ordered and joined, in that order', () => {
  assert.deepEqual(stageNames(filmsOf('u1')), [
    '$match',
    '$sort',
    '$lookup',
    '$project',
  ])
})

test('a limited list limits before the join, not after it', () => {
  const pipeline = filmsOf('u1', 5)

  assert.deepEqual(stageNames(pipeline), [
    '$match',
    '$sort',
    '$limit',
    '$lookup',
    '$project',
  ])
  // The point of the whole thing: five works joined rather than four hundred.
  assert.equal(stage(pipeline, '$limit'), 5)
})

test('an unlimited list has no $limit stage at all', () => {
  // `undefined` is what `parseInt('') || undefined` gives for a request that
  // asked for no limit, and `{ $limit: undefined }` is an error from the
  // server rather than a stage that does nothing.
  assert.equal(stage(filmsOf('u1', undefined), '$limit'), undefined)
  assert.equal(stage(filmsOf('u1', 0), '$limit'), undefined)
})

test('only the asking user\'s entries are matched', () => {
  assert.deepEqual(stage(filmsOf('u1'), '$match'), { userId: 'u1' })
})

test('newest first, with a stable tiebreak', () => {
  assert.deepEqual(stage(filmsOf('u1'), '$sort'), { updatedDate: -1, _id: 1 })
})

test('the join names the work collection it was given', () => {
  assert.deepEqual(stage(filmsOf('u1'), '$lookup'), {
    from: 'films',
    localField: 'workRef',
    foreignField: '_id',
    as: 'work',
  })
  assert.equal(
    toUserEntriesPipeline({ userId: 'u1', workCollection: 'games' }).find(
      (stage) => stage.$lookup
    ).$lookup.from,
    'games'
  )
})

test('a list carries neither the notes nor the owner it does not render', () => {
  assert.deepEqual(stage(filmsOf('u1'), '$project'), {
    review: 0,
    userId: 0,
    commonMetadata: 0,
  })
})

test('the stale copy of the work is dropped, not sent alongside the fresh one', () => {
  // `commonMetadata` on the document is a pre-migration snapshot of the work
  // the `$lookup` has just fetched, and the caller overwrites it with
  // `work.data`. Unprojected it was 1.2 MB read out of Atlas per profile load
  // to be thrown away in Node. See #176.
  assert.equal(stage(filmsOf('u1'), '$project').commonMetadata, 0)
})

test('the pipeline is built fresh, so a caller cannot mutate the next one', () => {
  const first = filmsOf('u1', 5)
  first[0].$match.userId = 'someone else'

  assert.deepEqual(stage(filmsOf('u2', 5), '$match'), { userId: 'u2' })
})

test('a score histogram is counted by the database, not fetched to be counted', () => {
  // The point of the whole thing: eleven rows of counts come back rather than
  // every entry the user has.
  assert.deepEqual(toScoreTallyPipeline({ userId: 'u1' }), [
    { $match: { userId: 'u1', status: { $ne: 'Planned' } } },
    { $group: { _id: '$score', count: { $sum: 1 } } },
  ])
})

test('a histogram counts everything except Planned', () => {
  // `$ne` and not `{ $nin: [...] }`: it has to match an entry with no status
  // field at all, which is what `doc.data.status !== 'Planned'` counted.
  assert.deepEqual(stage(toScoreTallyPipeline({ userId: 'u1' }), '$match'), {
    userId: 'u1',
    status: { $ne: 'Planned' },
  })
})

test('the histogram pipeline is built fresh too', () => {
  const first = toScoreTallyPipeline({ userId: 'u1' })
  first[0].$match.userId = 'someone else'

  assert.equal(stage(toScoreTallyPipeline({ userId: 'u2' }), '$match').userId, 'u2')
})

test('options nobody asked for are left out rather than sent as undefined', () => {
  assert.deepEqual(toFindOptions(), {})
  assert.deepEqual(toFindOptions({}), {})
  assert.deepEqual(toFindOptions({ limit: 0 }), {})
})

test('a projection, a sort and a limit are passed through', () => {
  assert.deepEqual(
    toFindOptions({ projection: { score: 1 }, sort: { _id: 1 }, limit: 1 }),
    { projection: { score: 1 }, sort: { _id: 1 }, limit: 1 }
  )
})

test('an exclusion projection stays an exclusion projection', () => {
  // Mixing inclusions and exclusions is an error from the server, so `_id`
  // must not be added to one of these.
  assert.deepEqual(toFindOptions({ projection: { snapshot: 0 } }), {
    projection: { snapshot: 0 },
  })
})

test('a session is passed through, so a read can join a transaction', () => {
  const session = { id: 'a session' }

  assert.deepEqual(toFindOptions({ session }), { session })
  assert.deepEqual(toFindOptions({ projection: { score: 1 }, session }), {
    projection: { score: 1 },
    session,
  })
})

test('a projection cannot drop the _id that becomes ref.id', () => {
  // Without `_id` the wrapper hands back `ref: { id: undefined }`, and a row
  // nothing can update or delete looks exactly like one that can.
  assert.deepEqual(toFindOptions({ projection: { _id: 0, score: 1 } }), {
    projection: { score: 1 },
  })
  assert.deepEqual(toFindOptions({ projection: { _id: false, score: 1 } }), {
    projection: { score: 1 },
  })
})
