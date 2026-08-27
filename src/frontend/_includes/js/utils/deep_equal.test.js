/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this evaluates deep_equal.js in a vm context and
 * pulls the comparison out of the script's scope.
 *
 * The fixtures below are built out here and compared in there, which is a
 * second realm's worth of `Object.prototype`. That is deliberate: it is the
 * cheapest way to hold `isPlainObject` to reading a plain object as one.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, 'deep_equal.js'), 'utf8')

// The `js()` macro in bundle.njk wraps each bundled file in its own IIFE,
// which is what keeps two files' `const`s from colliding. Loading it the same
// way here keeps that difference visible.
const { DeepEqual } = vm.runInContext(
  `(() => {\n${source}\n;return ({ DeepEqual })\n})()`,
  vm.createContext({})
)

const { deepEqual } = DeepEqual

/** A snapshot as `readForm` builds one, for a film. */
const snapshot = () => ({
  workRef: 'films__1234',
  overrides: {
    englishTranslatedTitle: 'Fargo',
    releaseYear: 1996,
    directors: ['Joel Coen', 'Ethan Coen'],
  },
  status: 'completed',
  score: 9,
  completedDate: 1717200000000,
  review: 'a masterpiece',
})

test('the same values, all the way down', () => {
  assert.equal(deepEqual(snapshot(), snapshot()), true)
})

test('one field different is different', () => {
  assert.equal(deepEqual(snapshot(), { ...snapshot(), score: 8 }), false)
})

test('a field inside overrides is reached', () => {
  // The one nested object a snapshot has, and the one `comparable()` recurses
  // into. A comparison that stopped at the top level would call these equal.
  const changed = snapshot()
  changed.overrides = { ...changed.overrides, releaseYear: 1997 }

  assert.equal(deepEqual(snapshot(), changed), false)
})

test('key order is not a difference', () => {
  // The whole reason this is not `JSON.stringify(a) === JSON.stringify(b)`.
  // The form writes the fields in the order `readForm` lists them; a draft
  // read back from the database arrives in whatever order it was stored in,
  // and every field would read as changed.
  assert.equal(
    deepEqual(
      { status: 'completed', score: 9, review: '' },
      { review: '', status: 'completed', score: 9 }
    ),
    true
  )
})

test('an absent field is not a field holding undefined', () => {
  // Same key count, and both answer `undefined` to either name. `comparable()`
  // strips undefined before it gets here, so this is the check that says what
  // happens if it ever stops.
  assert.equal(deepEqual({ score: undefined }, { status: undefined }), false)
  assert.equal(deepEqual({ score: undefined }, {}), false)
})

test('a missing field is different from one that is there', () => {
  const { progress: _progress, ...withoutProgress } = { ...snapshot(), progress: 3 }

  assert.equal(deepEqual({ ...snapshot(), progress: 3 }, withoutProgress), false)
})

test('null, undefined and absent are three different things', () => {
  assert.equal(deepEqual(null, undefined), false)
  assert.equal(deepEqual(null, null), true)
  assert.equal(deepEqual(undefined, undefined), true)
  assert.equal(deepEqual({ score: null }, { score: undefined }), false)
})

test('nothing is coerced', () => {
  // A score comes off the form through `parseInt` and out of the database as
  // a number, but a `progress` typed and never parsed would be a string, and
  // `9` and `'9'` are not the same thing to store.
  assert.equal(deepEqual(9, '9'), false)
  assert.equal(deepEqual(0, ''), false)
  assert.equal(deepEqual(null, 0), false)
  assert.equal(deepEqual(false, 0), false)
})

test('NaN is equal to itself here, whatever === says', () => {
  // Otherwise a field holding one reports itself as changed on every
  // comparison, on a timer, for as long as the form is open.
  assert.equal(deepEqual(NaN, NaN), true)
  assert.equal(deepEqual({ score: NaN }, { score: NaN }), true)
  assert.equal(deepEqual(NaN, 0), false)
})

test('arrays compare by position, and by length', () => {
  // Every list-valued override — genres, directors, actors, platforms — is
  // one of these, and reordering the directors of a film is an edit.
  assert.equal(deepEqual(['Joel Coen', 'Ethan Coen'], ['Joel Coen', 'Ethan Coen']), true)
  assert.equal(deepEqual(['Joel Coen', 'Ethan Coen'], ['Ethan Coen', 'Joel Coen']), false)
  assert.equal(deepEqual(['Joel Coen'], ['Joel Coen', 'Ethan Coen']), false)
  assert.equal(deepEqual([], []), true)
})

test('an array is not an object that happens to answer to 0 and 1', () => {
  assert.equal(deepEqual(['a', 'b'], { 0: 'a', 1: 'b' }), false)
  assert.equal(deepEqual([], {}), false)
})

test('nested arrays and objects are followed', () => {
  assert.equal(
    deepEqual(
      { tags: [{ name: 'noir' }, { name: 'crime' }] },
      { tags: [{ name: 'noir' }, { name: 'crime' }] }
    ),
    true
  )
  assert.equal(
    deepEqual(
      { tags: [{ name: 'noir' }] },
      { tags: [{ name: 'noirish' }] }
    ),
    false
  )
})

test('anything with a class of its own is equal only to itself', () => {
  // Documented rather than incidental. Comparing two of these as *equal* is
  // the direction that loses an edit, so the unreadable ones say "different".
  const date = new Date(0)

  assert.equal(deepEqual(date, date), true)
  assert.equal(deepEqual(new Date(0), new Date(0)), false)
  assert.equal(deepEqual(new Map(), new Map()), false)
  assert.equal(deepEqual(/a/, /a/), false)
})

test('an object built out here reads as a plain object in there', () => {
  // `isPlainObject` compares tags rather than prototypes for this reason: the
  // fixture's `Object.prototype` is not the one deep_equal.js was evaluated
  // against, and comparing prototypes would call every object above a class
  // instance and every one of these tests would pass for the wrong reason.
  assert.equal(deepEqual({ a: 1 }, { a: 1 }), true)
  assert.equal(deepEqual(Object.create(null), {}), true)
})

test('the field-by-field comparison the draft summary makes', () => {
  // `summarise()` in draft.js walks the union of the two snapshots' keys and
  // asks this about one field at a time, so it is handed bare scalars, bare
  // arrays and `undefined` as often as it is handed an object.
  const saved = snapshot()
  const draft = {
    ...saved,
    score: 7,
    overrides: { ...saved.overrides, directors: ['Joel Coen'] },
  }

  const changed = Object.keys({ ...draft, ...saved })
    .filter((field) => !deepEqual(draft[field], saved[field]))

  assert.deepEqual(changed, ['overrides', 'score'])
})
