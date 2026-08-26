import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_COMPANIES_PER_QUERY, involvedCompanyIds, companyIdsToLookUp, companyQueryLimit, indexCompanyNamesById, companyNames } from './companies.js'
/**
 * `involved_companies.*` as IGDB sends it: company ids and role flags, one
 * row per company per game. Team Cherry developed and published Hollow
 * Knight; Skybound published it and developed nothing.
 */
const hollowKnightCompanies = [
  { id: 1, company: 4432, developer: true, publisher: true, porting: false },
  { id: 2, company: 9312, developer: false, publisher: true, porting: false },
]

/** The `/companies` rows for those two ids. */
const companyRows = [
  { id: 4432, name: 'Team Cherry' },
  { id: 9312, name: 'Skybound Games' },
]

test('the ids under each role come out separately', () => {
  assert.deepEqual(involvedCompanyIds(hollowKnightCompanies, 'developer'), [4432])
  assert.deepEqual(
    involvedCompanyIds(hollowKnightCompanies, 'publisher'),
    [4432, 9312],
  )
})

test('a game IGDB lists no companies for has no ids rather than throwing', () => {
  assert.deepEqual(involvedCompanyIds(undefined, 'developer'), [])
  assert.deepEqual(involvedCompanyIds([], 'developer'), [])
  assert.deepEqual(involvedCompanyIds(null, 'developer'), [])
  assert.deepEqual(involvedCompanyIds({ company: 4432, developer: true }, 'developer'), [])
})

test('a row with no usable company id is skipped', () => {
  assert.deepEqual(
    involvedCompanyIds([{ developer: true }, { company: null, developer: true }], 'developer'),
    [],
  )
})

test('a company asked about under both roles is asked about once', () => {
  // Team Cherry is in both lists. Sending it twice spends the query's limit
  // on a name the first row already carried.
  const studioIds = involvedCompanyIds(hollowKnightCompanies, 'developer')
  const publisherIds = involvedCompanyIds(hollowKnightCompanies, 'publisher')

  assert.deepEqual(companyIdsToLookUp(studioIds, publisherIds), [4432, 9312])
  assert.deepEqual(companyIdsToLookUp([], []), [])
})

test('the query asks for as many rows as it named ids', () => {
  // The `limit 50` this replaced was fixed, and applied to both roles at
  // once: a game with 51 involved companies could not resolve all of them.
  assert.equal(companyQueryLimit([1, 2, 3]), 3)
  assert.equal(companyQueryLimit(Array.from({ length: 51 }, (_, i) => i)), 51)
})

test('the query stays within what IGDB will return', () => {
  const tooMany = Array.from({ length: MAX_COMPANIES_PER_QUERY + 10 }, (_, i) => i)

  assert.equal(companyQueryLimit(tooMany), MAX_COMPANIES_PER_QUERY)
  // `limit 0` is rejected outright, so an empty list still asks for a row.
  assert.equal(companyQueryLimit([]), 1)
})

test('names come back in the order the ids were asked for', () => {
  assert.deepEqual(companyNames([9312, 4432], companyRows), ['Skybound Games', 'Team Cherry'])
})

test('an id the response did not carry is dropped, not left as a hole', () => {
  // #214: this was `[ 'Team Cherry', undefined ]`, and `gameParser` declares
  // `studios` as `z.array(z.string())`, so the whole work was rejected over
  // one company IGDB would not name.
  const names = companyNames([4432, 55555], companyRows)

  assert.deepEqual(names, ['Team Cherry'])
  assert.ok(names.every((name) => typeof name === 'string'))
})

test('a game none of whose companies resolve has no studios rather than holes', () => {
  assert.deepEqual(companyNames([55555, 66666], companyRows), [])
  assert.deepEqual(companyNames([4432], []), [])
  assert.deepEqual(companyNames([4432], undefined), [])
  assert.deepEqual(companyNames(undefined, companyRows), [])
})

test('a row with no name is not a name', () => {
  assert.deepEqual(companyNames([4432, 9312], [{ id: 4432 }, { id: 9312, name: null }]), [])
})

test('ids match their rows across number and string', () => {
  // `companies.find((c) => c.id === id)` was strict equality on whatever the
  // two responses happened to hold.
  assert.deepEqual(companyNames(['4432'], companyRows), ['Team Cherry'])
  assert.deepEqual(companyNames([4432], [{ id: '4432', name: 'Team Cherry' }]), ['Team Cherry'])
})

test('the index skips rows that identify nothing', () => {
  const namesById = indexCompanyNamesById([
    { name: 'Nameless id' },
    { id: 4432, name: 'Team Cherry' },
  ])

  assert.deepEqual([...namesById], [[4432, 'Team Cherry']])
  assert.deepEqual([...indexCompanyNamesById(null)], [])
})
