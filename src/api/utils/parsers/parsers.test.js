/**
 * @file What the parsers accept and what they drop.
 *
 * These guard every write path in the API, and until #182 nothing tested them
 * directly — the coverage was whatever the controller tests happened to send
 * through. That gap is the reason the zod 4 upgrade was dangerous: the one
 * rule it changed is the one no test named.
 *
 * **A field that may be left out.** Every optional field here used to be
 * written `.or(z.undefined())`, and zod 3 let a key be missing whenever its
 * schema accepted `undefined`. Zod 4 does not: a key may be absent only when
 * its schema is optional in zod's own sense. So each of these has a case for
 * the key being *absent*, not merely present and undefined — the two are
 * different questions now, and only the first one broke.
 *
 * `zod` is a dependency, so the file **skips itself** when it isn't installed
 * (which is how CI runs the suite), the same way responses.test.js does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('zod')
    await import('neverthrow')
    await import('validator')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

const parsers = dependenciesInstalled ? await import('./index.js') : {}
const updates = dependenciesInstalled ? await import('./updates.js') : {}
const revisions = dependenciesInstalled ? await import('./revisions.js') : {}
const users = dependenciesInstalled ? await import('./users.js') : {}

/** The value a parser produced, or an assertion failure naming the error. */
const parsed = (validator, input) => {
  const result = validator(input)
  assert.equal(result.isOk(), true, result.isOk() ? '' : String(result.error.detail))
  return result.value
}

/** That a parser rejected, and as a RequestError — a 400 rather than a 500. */
const rejected = (validator, input) => {
  const result = validator(input)
  assert.equal(result.isErr(), true, 'expected this to be rejected')
  assert.equal(result.error.error, 'RequestError')
  return result.error
}

const BOOK = {
  apiRefs: ['isbn__9780156012195'],
  entryType: 'Book',
  englishTranslatedTitle: 'The Little Prince',
}

const ENTRY = { userId: 'u1', status: 'Completed' }

///////////////////////////////////////////////////////////////////////////////
// A field that may be left out.

test('a work carrying only its required fields is accepted', options, () => {
  assert.deepEqual(parsed(parsers.books, BOOK), BOOK)
})

test('an entry carrying only its required fields is accepted', options, () => {
  assert.deepEqual(parsed(parsers.bookEntries, ENTRY), ENTRY)
})

test('a revision snapshot may be empty', options, () => {
  assert.deepEqual(parsed(revisions.snapshot, {}), {})
})

test('a user document need not carry stats or a biography', options, () => {
  assert.deepEqual(parsed(parsers.users, { userId: 'u1', username: 'someone' }), {
    userId: 'u1',
    username: 'someone',
  })
})

test('a review need not name the entry it belongs to', options, () => {
  assert.deepEqual(parsed(parsers.bookReviews, { text: 'Good.' }), { text: 'Good.' })
})

test('a draft revision has no supersededDate, and is still a revision', options, () => {
  const draft = {
    entryRef: 'e1',
    entryType: 'books',
    userId: 'u1',
    kind: 'draft',
    createdDate: 1700000000000,
    snapshot: { status: 'InProgress' },
  }

  assert.deepEqual(parsed(parsers.entryRevisions, draft), draft)
})

test('an optional field sent explicitly as undefined is accepted too', options, () => {
  const work = parsed(parsers.books, { ...BOOK, releaseYear: undefined })

  assert.equal(work.releaseYear, undefined)
})

test('an optional field still refuses a value of the wrong type', options, () => {
  rejected(parsers.books, { ...BOOK, releaseYear: 'nineteen forty-three' })
})

test('a required field left out is still refused', options, () => {
  rejected(parsers.books, { entryType: 'Book' })
  rejected(parsers.bookEntries, { status: 'Completed' })
})

///////////////////////////////////////////////////////////////////////////////
// What a parser drops.

test('a key the parser was not told about does not survive', options, () => {
  const work = parsed(parsers.books, { ...BOOK, sneaky: 'value' })

  assert.equal('sneaky' in work, false)
})

test('an update may not rewrite the fields that decide ownership', options, () => {
  // The three that came through the gap `entryUpdateParser` closed: `userId`
  // is what every ownership check reads, `review` belongs in its own
  // collection, and `commonMetadata` is what the form sends on every save.
  const update = parsed(updates.bookEntries, {
    score: 9,
    userId: 'someone-else',
    review: 'a duplicated note',
    commonMetadata: null,
  })

  assert.deepEqual(update, { score: 9 })
})

test('an update may be empty, and may set a single field', options, () => {
  assert.deepEqual(parsed(updates.bookEntries, {}), {})
  assert.deepEqual(parsed(updates.bookEntries, { status: 'Dropped' }), {
    status: 'Dropped',
  })
})

test('an update is checked as closely as a creation', options, () => {
  rejected(updates.bookEntries, { score: 11 })
  rejected(updates.bookEntries, { status: 'Abandoned' })
})

///////////////////////////////////////////////////////////////////////////////
// The values themselves.

test('a score outside 1-10 is refused, and no score at all is not', options, () => {
  assert.equal(parsed(parsers.bookEntries, { ...ENTRY, score: 10 }).score, 10)
  assert.equal(parsed(parsers.bookEntries, { ...ENTRY, score: null }).score, null)
  rejected(parsers.bookEntries, { ...ENTRY, score: 0 })
  rejected(parsers.bookEntries, { ...ENTRY, score: 11 })
  rejected(parsers.bookEntries, { ...ENTRY, score: 7.5 })
})

test('a status outside the four is refused', options, () => {
  rejected(parsers.bookEntries, { ...ENTRY, status: 'Watching' })
})

test('a work parser refuses another type of work', options, () => {
  rejected(parsers.books, { ...BOOK, entryType: 'Film' })
  rejected(parsers.films, { ...BOOK, entryType: 'Book' })
})

test('an override is a partial work, and junk in it is dropped', options, () => {
  const entry = parsed(parsers.bookEntries, {
    ...ENTRY,
    overrides: { releaseYear: 1943, nonsense: true },
  })

  assert.deepEqual(entry.overrides, { releaseYear: 1943 })
})

test('a snapshot carries overrides of anything, so long as it is an object', options, () => {
  // Free-form because they mirror whichever work type the entry points at.
  assert.deepEqual(
    parsed(revisions.snapshot, { overrides: { anything: [1, 2] } }).overrides,
    { anything: [1, 2] },
  )
  assert.equal(parsed(revisions.snapshot, { overrides: null }).overrides, null)
  rejected(revisions.snapshot, { overrides: 'not an object' })
})

test('a username is 2 to 16 alphanumeric characters', options, () => {
  assert.equal(parsed(users.username, 'someone12'), 'someone12')
  rejected(users.username, 'a')
  rejected(users.username, 'a'.repeat(17))
  rejected(users.username, 'has a space')
  rejected(users.username, '<script>')
  rejected(users.username, 12345)
})

test('a biography is bounded, and may be absent', options, () => {
  const limit = users.MAX_BIOGRAPHY_LENGTH

  assert.equal(parsed(users.biography, 'x'.repeat(limit)).length, limit)
  assert.equal(parsed(users.biography, null), null)
  rejected(users.biography, 'x'.repeat(limit + 1))
})
