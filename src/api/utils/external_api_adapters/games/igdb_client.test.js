/**
 * @file That the IGDB client factory is still callable by the time igdb.js
 * has it.
 *
 * The rest of this folder is pure and tests the mapping. This one asks the
 * installed package a question no amount of pure testing can: what a default
 * import of it actually hands over here. #235 was that answer changing —
 * `igdb(…)` became "igdb is not a function", and every game search and every
 * game retrieve answered 500 — without a single line of the adapter changing
 * and without any test going red. See ../../interop.js.
 *
 * Needs the dependencies, so it **skips itself** when they aren't installed,
 * which is how CI runs the suite without an install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callableDefault } from '../../interop.js'

const igdbModule = await (async () => {
  try {
    return (await import('igdb-api-node')).default
  } catch (error) {
    return undefined
  }
})()

const options = {
  skip: igdbModule ? false : 'run `npm install` to run these',
}

test('the client factory survives the ESM/CommonJS boundary', options, () => {
  assert.equal(typeof callableDefault(igdbModule), 'function')
})

/**
 * The trap itself, pinned so that it is noticed if it ever stops being one:
 * should `igdb-api-node` ship ES modules, this goes red and the unwrapping in
 * igdb.js can go with it — `callableDefault` would pass the function straight
 * through either way, so nothing breaks in the meantime.
 */
test('the bare default import is the namespace, not the factory', options, () => {
  assert.notEqual(typeof igdbModule, 'function')
  assert.equal(typeof igdbModule.default, 'function')
})
