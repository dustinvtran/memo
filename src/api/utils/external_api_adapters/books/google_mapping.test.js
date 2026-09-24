import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpsUrl, toBook } from './google_mapping.js'

/**
 * A `/volumes` item's `volumeInfo`, as Google Books really answers an
 * `q=isbn:` lookup — the cover url included, which arrives over `http://`.
 */
const recursion = {
  title: 'Recursion',
  authors: ['Blake Crouch'],
  publisher: 'Crown',
  publishedDate: '2019-06-11',
  pageCount: 336,
  imageLinks: { thumbnail: 'http://books.google.com/recursion.jpg' },
  canonicalVolumeLink: 'https://books.google.com/books/about/Recursion.html',
}

///////////////////////////////////////////////////////////////////////////////
// The scheme, which is #394: 588 of 653 stored covers were `http://`, every
// one of them a CSP violation the report-only header logged and an enforced
// one would block.

test('an http cover is stored over TLS', () => {
  assert.equal(
    httpsUrl('http://books.google.com/books/content?id=-WlZIfnhjw8C&img=1'),
    'https://books.google.com/books/content?id=-WlZIfnhjw8C&img=1',
  )
})

test('a cover that already came over TLS is left alone', () => {
  assert.equal(
    httpsUrl('https://books.google.com/recursion.jpg'),
    'https://books.google.com/recursion.jpg',
  )
})

test('only the scheme is rewritten, not an http anywhere else in the url', () => {
  assert.equal(
    httpsUrl('https://books.google.com/x?u=http://elsewhere.test/a.jpg'),
    'https://books.google.com/x?u=http://elsewhere.test/a.jpg',
  )
})

test('a book with no cover does not acquire one', () => {
  // A string where there was nothing renders as a broken image; `undefined`
  // is what the rest of the pipeline reads as "no cover".
  assert.equal(httpsUrl(undefined), undefined)
  assert.equal(toBook('9781524759797', {}).imageUrl, undefined)
  assert.equal(
    toBook('9781524759797', { imageLinks: {} }).imageUrl,
    undefined,
  )
})

///////////////////////////////////////////////////////////////////////////////
// What a retrieved volume is stored as.

test('a retrieved volume is stored with an https cover', () => {
  assert.equal(
    toBook('9781524759797', recursion).imageUrl,
    'https://books.google.com/recursion.jpg',
  )
})

test('a retrieved volume carries the fields a book is made of', () => {
  assert.deepEqual(toBook('9781524759797', recursion), {
    entryType: 'Book',
    publishers: ['Crown'],
    englishTranslatedTitle: 'Recursion',
    releaseYear: 2019,
    duration: 336,
    imageUrl: 'https://books.google.com/recursion.jpg',
    authors: ['Blake Crouch'],
    apiRefs: ['ISBN__9781524759797'],
    externalUrls: [{
      name: 'Google Play',
      url: 'https://books.google.com/books/about/Recursion.html',
    }],
  })
})

test('a book is filed under the ISBN asked for, not one out of the answer', () => {
  // The lookup is by ISBN and the work is filed under it; Google lists both an
  // ISBN_10 and an ISBN_13 and neither need be the one asked for.
  assert.deepEqual(toBook('1524759791', recursion).apiRefs, ['ISBN__1524759791'])
})

test('a volume Google holds no year or publisher for leaves them unset', () => {
  const sparse = toBook('9781524759797', { title: 'Recursion' })

  assert.equal(sparse.releaseYear, undefined)
  assert.equal(sparse.publishers, undefined)
  assert.deepEqual(sparse.externalUrls, [])
})

/**
 * #442, and the reason #436 was reverted by #437. The search joins a
 * subtitle so the picker can tell eight "Sapiens" apart; the retrieve stores
 * the bare title so a later refresh compares bare against bare. Making the
 * two agree looks obviously right and was measured to be wrong — it took the
 * refusals from 13 to 79, because Google splits `title` and `subtitle`
 * inconsistently across editions, so joining swaps which books disagree
 * rather than making them agree.
 *
 * The assertion is here rather than in a comment because a comment is what
 * #436 read past.
 */
test('the retrieve stores the bare title, and the search joins the subtitle', async () => {
  const { titleOf } = await import('./google_search.js')
  const volumeInfo = { title: 'The Bell Jar', subtitle: 'A Novel' }

  assert.equal(toBook('9780571081783', volumeInfo).englishTranslatedTitle, 'The Bell Jar')
  assert.equal(titleOf(volumeInfo), 'The Bell Jar: A Novel')

  // A volume with no subtitle is the same string either way, which is why the
  // divergence is invisible for most books and was left to a data pass to find.
  const plain = { title: 'Recursion' }
  assert.equal(toBook('9781524759797', plain).englishTranslatedTitle, titleOf(plain))
})
