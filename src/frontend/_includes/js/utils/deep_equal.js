/**
 * @file Whether two values are the same all the way down.
 *
 * One caller: the draft notice compares form snapshots with this, to decide
 * whether an autosaved draft still says anything the entry does not. It was
 * `R.equals`, and Ramda was 44 KB fetched by every page on the site, before
 * anything drew, for three calls. #269.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` is the tempting one-liner and it
 * is the wrong answer: it compares key order, so the same snapshot written by
 * the form and read back from the database is two different strings whenever
 * the fields came out in a different order, and every field reads as changed.
 * It also cannot see the difference between a key that is absent and one
 * holding `undefined` — which is the difference `comparable()` in `draft.js`
 * exists to erase, so it is not a difference to be vague about.
 *
 * Pure and dependency-free, so `deep_equal.test.js` beside it holds the whole
 * of what this does with no install, no DOM and no network.
 */

/**
 * Structural equality over what a form snapshot holds: strings, numbers,
 * `null`, `undefined`, arrays of those, and plain objects of those.
 *
 * Anything carrying a class of its own — a `Date`, a `Map`, a `RegExp`, an
 * `Error` — is equal only to itself. That is the conservative direction and
 * it is chosen: two values this cannot read compare as *different*, so the
 * worst it does is offer to restore a draft that turns out to change nothing.
 * Comparing them as equal would lose an edit instead. A snapshot holds none of
 * them today — `readForm` writes dates as epoch milliseconds — and this is
 * what keeps that from being a silent assumption.
 */
const deepEqual = (a, b) => {
  if (a === b) return true

  // The one value that is not equal to itself, so without this a field
  // holding it reads as changed on every comparison, forever.
  if (Number.isNaN(a) && Number.isNaN(b)) return true

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    )
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return false

  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => hasOwn(b, key) && deepEqual(a[key], b[key]))
  )
}

DeepEqual = {
  deepEqual,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * Both sides have to be asked whether the key is there at all.
 * `{ score: undefined }` and `{ status: undefined }` have one key each and
 * answer `undefined` to either name, so on key count and lookup alone they
 * compare equal.
 */
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/**
 * An object literal, or `Object.create(null)`, and nothing with a class.
 *
 * `Object.prototype.toString` rather than a comparison against
 * `Object.prototype` itself: an object built in another realm has that
 * realm's prototype and would fail the comparison while being, in every way
 * that matters here, a plain object. The test beside this file builds its
 * fixtures in one realm and runs this in another, which is the same trap.
 */
const isPlainObject = (value) =>
  typeof value === 'object' &&
  value !== null &&
  Object.prototype.toString.call(value) === '[object Object]'
