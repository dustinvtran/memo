import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_GAME_IDS_PER_QUERY, DURATION_SOURCE, timeToBeatQuery, batchGameIds, toDurationInMinutes, toPlaytime, indexTimesByGameId } from './time_to_beat.js'
/** A row exactly as IGDB returns it, times in seconds. */
const aRealRow = {
  game_id: 3042,
  hastily: 45000,
  normally: 102780,
  completely: 165270,
  count: 13,
}

test('the query names the plural endpoint fields and stays within one page', () => {
  const query = timeToBeatQuery([3042, 14593])

  assert.match(query, /^fields game_id,hastily,normally,completely,count; /)
  assert.match(query, /where game_id = \(3042,14593\);/)
  assert.match(query, new RegExp(`limit ${MAX_GAME_IDS_PER_QUERY};$`))
})

test('ids are batched into whole queries', () => {
  const ids = Array.from({ length: MAX_GAME_IDS_PER_QUERY * 2 + 7 }, (_, i) => i)
  const batches = batchGameIds(ids)

  assert.equal(batches.length, 3)
  assert.equal(batches[0].length, MAX_GAME_IDS_PER_QUERY)
  assert.equal(batches[2].length, 7)
  assert.deepEqual(batches.flat(), ids)
})

test('no ids means no queries at all', () => {
  assert.deepEqual(batchGameIds([]), [])
})

test('seconds become whole minutes', () => {
  // 102780s is 28h33m. `duration` is in minutes everywhere else.
  assert.equal(toDurationInMinutes(aRealRow), 1713)
  assert.equal(toDurationInMinutes({ normally: 90 }), 2)
})

test('the mapped field is the typical time, not the rushed one', () => {
  // `hastily` is a rushed time (45000s = 12h30m here), well under what a
  // player who is not speedrunning will see.
  assert.equal(toDurationInMinutes(aRealRow), 1713)
  assert.notEqual(toDurationInMinutes(aRealRow), 750)
})

test('a game IGDB has no time for gets no playtime rather than a zero', () => {
  assert.equal(toDurationInMinutes(undefined), undefined)
  assert.equal(toDurationInMinutes({}), undefined)
  assert.equal(toDurationInMinutes({ game_id: 1, hastily: 3600 }), undefined)
  assert.equal(toDurationInMinutes({ normally: 0 }), undefined)
  assert.equal(toDurationInMinutes({ normally: -60 }), undefined)
  assert.equal(toDurationInMinutes({ normally: '45000' }), undefined)
  assert.equal(toDurationInMinutes({ normally: NaN }), undefined)
})

test('a playtime under a minute still rounds to a minute', () => {
  assert.equal(toDurationInMinutes({ normally: 20 }), 1)
})

test('a playtime carries its provenance with it', () => {
  assert.deepEqual(toPlaytime(aRealRow), {
    duration: 1713,
    durationSource: DURATION_SOURCE,
  })
})

test('no playtime means no provenance either', () => {
  // Writing `durationSource` next to a duration that came from somewhere else
  // is the one way this could make the database less trustworthy than before.
  assert.equal(toPlaytime({ game_id: 1 }), undefined)
  assert.equal(toPlaytime(undefined), undefined)
})

test('rows are indexed by numeric game id', () => {
  // Our apiRefs are strings and IGDB answers with numbers, so both shapes
  // have to land under the same key.
  const times = indexTimesByGameId([aRealRow, { game_id: '14593', normally: 60 }])

  assert.equal(times.get(3042), aRealRow)
  assert.equal(times.get(14593).normally, 60)
  assert.equal(times.get(99), undefined)
})

test('rows without a usable game id are dropped', () => {
  assert.equal(indexTimesByGameId([{ normally: 60 }, { game_id: 'N/A' }]).size, 0)
  assert.equal(indexTimesByGameId(undefined).size, 0)
  assert.equal(indexTimesByGameId({}).size, 0)
})
