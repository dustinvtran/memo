import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformName, platformNames, searchTitle } from './platforms.js'

/**
 * `platforms.abbreviation` and `platforms.name` as IGDB sends them. Most
 * platforms carry both; Satellaview is one of 94 that IGDB gives only a name
 * (measured 2026-09-29), which is the row that used to be stored as `"?"`.
 * #480.
 */
const platforms = [
  { id: 6, abbreviation: 'PC', name: 'PC (Microsoft Windows)' },
  { id: 306, name: 'Satellaview' },
  { id: 19, abbreviation: 'SNES', name: 'Super Nintendo Entertainment System' },
]

test('a platform is named by its abbreviation when it has one', () => {
  assert.equal(platformName(platforms[0]), 'PC')
})

test('a platform with no abbreviation is named in full rather than as "?"', () => {
  assert.equal(platformName(platforms[1]), 'Satellaview')
  assert.equal(platformName({ abbreviation: '', name: 'Satellaview' }), 'Satellaview')
  assert.equal(platformName({ abbreviation: null, name: 'Satellaview' }), 'Satellaview')
})

test('a platform named neither way has no name', () => {
  assert.equal(platformName({ id: 1 }), undefined)
  assert.equal(platformName({ abbreviation: ' ', name: '' }), undefined)
  assert.equal(platformName(undefined), undefined)
})

test('a game\'s platforms keep IGDB\'s order and never hold a "?"', () => {
  assert.deepEqual(platformNames(platforms), ['PC', 'Satellaview', 'SNES'])
  assert.deepEqual(platformNames([...platforms, { id: 99 }]), ['PC', 'Satellaview', 'SNES'])
})

test('two platforms under one abbreviation are stored once', () => {
  // #481: every value in the column is a link, so a repeat draws twice.
  assert.deepEqual(
    platformNames([{ abbreviation: 'PC' }, { abbreviation: 'PC' }, { name: 'Linux' }]),
    ['PC', 'Linux'],
  )
})

test('a game IGDB lists no platforms for has none rather than throwing', () => {
  assert.deepEqual(platformNames(undefined), [])
  assert.deepEqual(platformNames(null), [])
  assert.deepEqual(platformNames({ abbreviation: 'PC' }), [])
})

test('a search title brackets the platforms, and drops the brackets when there are none', () => {
  assert.equal(searchTitle('Chrono Trigger', platforms), 'Chrono Trigger [PC, Satellaview, SNES]')
  assert.equal(searchTitle('Chrono Trigger', [{ id: 99 }]), 'Chrono Trigger')
  assert.equal(searchTitle('Chrono Trigger', undefined), 'Chrono Trigger')
})
