import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unique } from './unique.js'

test('a repeat is dropped and the first sighting keeps its place', () => {
  // #481's shape, and the order is the API's billing, so it has to survive.
  assert.deepEqual(unique(['Valve', 'Hidden Path', 'Valve']), ['Valve', 'Hidden Path'])
  assert.deepEqual(unique(['Valve', 'Valve']), ['Valve'])
})

test('a list with no repeats comes back as it went in', () => {
  assert.deepEqual(unique(['PC', 'SNES', 'PS4']), ['PC', 'SNES', 'PS4'])
  assert.deepEqual(unique([]), [])
})

test('only an exact match is a repeat', () => {
  // Folding these would be choosing which of the API's spellings is right.
  assert.deepEqual(unique(['Valve', 'valve', 'Valve ']), ['Valve', 'valve', 'Valve '])
})
