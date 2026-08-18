/**
 * @file The one test that says what "the db module found nothing" looks like.
 *
 * Dependency-free, like the module it covers, so it runs in the suite CI
 * actually runs — no install, no database. The endpoints that used to 502 on
 * a miss are covered through their handlers in ../../controllers/stats.test.js,
 * which needs the dependencies and skips itself without them.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isFound } = require('./found')
const { toSameFormatAsFaunaDb } = require('./shapes')

test('the empty object a miss comes back as is not a document', () => {
  assert.equal(isFound({}), false)
})

test('a document the db module shaped is found', () => {
  assert.equal(isFound(toSameFormatAsFaunaDb({ _id: 'a1', username: 'someone' })), true)
})

/**
 * The reason this asks about `ref` and not `data`: a `users` document created
 * by `create_` for a brand-new account carries a `userId` and nothing else,
 * and it is still a document. A test on `data.stats`, or on any other field a
 * caller happens to want, would call that a miss and take the absent branch.
 */
test('a document is found on its ref, whatever it does or does not carry', () => {
  assert.equal(isFound({ data: {}, ref: { id: 'a1' } }), true)
})

test('nothing at all is not a document', () => {
  assert.equal(isFound(undefined), false)
  assert.equal(isFound(null), false)
})

/** `unwrapOr({})` and `okAsync({})` are how two callers seed the miss. */
test('a half-shaped document does not pass for one', () => {
  assert.equal(isFound({ ref: {} }), false)
  assert.equal(isFound({ ref: { id: undefined } }), false)
  assert.equal(isFound({ data: { username: 'someone' } }), false)
})
