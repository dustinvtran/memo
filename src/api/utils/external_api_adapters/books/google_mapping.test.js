import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpsUrl, toBook, titleOf } from './google_mapping.js'

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

test('a retrieve states the subtitle, the way a search already did', () => {
  // The asymmetry that froze thirteen books: stored from a search as
  // "Title: Subtitle", retrieved as "Title", refused by the title guard for
  // ever. One definition now answers both. #385.
  const volumeInfo = {
    title: 'The Idea Factory',
    subtitle: 'Bell Labs and the Great Age of American Innovation',
    authors: ['Jon Gertner'],
  }
  assert.equal(
    toBook('9781101561089', volumeInfo).englishTranslatedTitle,
    'The Idea Factory: Bell Labs and the Great Age of American Innovation'
  )
  assert.equal(titleOf(volumeInfo), toBook('x', volumeInfo).englishTranslatedTitle)
})

test('a volume with no subtitle is unchanged', () => {
  assert.equal(titleOf({ title: 'Flatland' }), 'Flatland')
  assert.equal(toBook('x', { title: 'Flatland' }).englishTranslatedTitle, 'Flatland')
})

test('a volume with no title at all is undefined rather than an empty string', () => {
  // `isEmptyValue` recognises absence; an empty string is a stored value that
  // no refresh would replace.
  assert.equal(titleOf({}), undefined)
  assert.equal(titleOf({ subtitle: 'orphaned' }), 'orphaned')
  assert.equal(toBook('x', {}).englishTranslatedTitle, undefined)
})
