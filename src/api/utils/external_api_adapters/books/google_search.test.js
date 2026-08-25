import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGES, PAGE_SIZE, isbnOf, matchRank, normalizeTitle, queriesFor, searchUrls, titleOf, toSearchResult, toSearchResults } from './google_search.js'
/** A `/volumes` item, cut down to the fields that are read. */
const aVolume = (volumeInfo) => ({ volumeInfo })

/** Both of a volume's ISBNs, in the order Google lists them. */
const isbns = (isbn13, isbn10) => [
  { type: 'ISBN_13', identifier: isbn13 },
  { type: 'ISBN_10', identifier: isbn10 },
]

const theNovel = aVolume({
  title: 'Recursion',
  subtitle: 'A Novel',
  authors: ['Blake Crouch'],
  publishedDate: '2019-06-11',
  industryIdentifiers: isbns('9781524759797', '1524759791'),
  imageLinks: { thumbnail: 'https://books.google.com/recursion.jpg' },
})

const theTextbook = aVolume({
  title: 'Recursion Theory',
  authors: ['Joseph R. Shoenfield'],
  publishedDate: '2017-03-02',
  industryIdentifiers: isbns('9781315077871', '1315077876'),
})

const aJournal = aVolume({
  title: 'Bulletin of the American Mathematical Society',
  publishedDate: '1930',
  industryIdentifiers: [{ type: 'OTHER', identifier: 'UOM:39015026287299' }],
})

///////////////////////////////////////////////////////////////////////////////
// What gets asked for, which is half of the bug this file exists for: one
// request for `recursion` had the novel nowhere in it at all.

test('the search is title-restricted first, then as typed', () => {
  assert.deepEqual(
    queriesFor('recursion'),
    ['intitle:"recursion"', 'recursion'],
  )
})

test('a multi-word query is one title phrase, not a first word and a rest', () => {
  // `intitle:the hobbit` asks for "the" in the title and "hobbit" anywhere.
  assert.equal(queriesFor('the hobbit')[0], 'intitle:"the hobbit"')
})

test("a quote in the query can't close the one around it", () => {
  assert.equal(queriesFor('say "hello"')[0], 'intitle:"say  hello "')
})

test('every query is asked for by the page, because a response holds 20', () => {
  const urls = searchUrls('recursion')

  assert.equal(urls.length, 2 * PAGES)
  assert.deepEqual(
    urls.map((url) => new URL(url).searchParams.get('startIndex')),
    ['0', '20', '0', '20'],
  )
  assert.ok(urls.every((url) =>
    new URL(url).searchParams.get('maxResults') === String(PAGE_SIZE)
  ))
})

test('the title-restricted pages are asked for first', () => {
  assert.deepEqual(
    searchUrls('recursion').map((url) => new URL(url).searchParams.get('q')),
    ['intitle:"recursion"', 'intitle:"recursion"', 'recursion', 'recursion'],
  )
})

test('journals and magazines are left out of the search itself', () => {
  assert.ok(searchUrls('recursion').every((url) =>
    new URL(url).searchParams.get('printType') === 'books'
  ))
})

test('the key, when there is one, survives being appended', () => {
  const urls = searchUrls('recursion', '&key=abc123')

  assert.ok(urls.every((url) => new URL(url).searchParams.get('key') === 'abc123'))
})

///////////////////////////////////////////////////////////////////////////////
// What comes back.

test('a book is offered under the ISBN it will be retrieved by', () => {
  // Whichever Google lists first, which is what books already in the database
  // are filed under.
  assert.equal(isbnOf(theNovel.volumeInfo), '9781524759797')
  assert.equal(isbnOf(aJournal.volumeInfo), undefined)
  assert.equal(isbnOf({}), undefined)
})

test('a row carries the subtitle, so that eight "Sapiens" are eight books', () => {
  assert.equal(titleOf(theNovel.volumeInfo), 'Recursion: A Novel')
  assert.equal(titleOf(theTextbook.volumeInfo), 'Recursion Theory')
})

test('a row is title, authors, year and cover', () => {
  assert.deepEqual(toSearchResult(theNovel.volumeInfo), {
    title: 'Recursion: A Novel [Blake Crouch]',
    year: '2019',
    ref: '9781524759797',
    imageUrl: 'https://books.google.com/recursion.jpg',
  })
})

test('a volume Google has no ISBN for is not offered', () => {
  // `retrieve` looks a book up by its ISBN, so there would be nothing to fetch.
  assert.deepEqual(toSearchResults('recursion', [[aJournal]]), [])
})

test('an edition that came back from both queries is offered once', () => {
  const results = toSearchResults('recursion', [[theNovel], [theNovel, theTextbook]])

  assert.deepEqual(results.map((r) => r.ref), ['9781524759797', '9781315077871'])
})

test('a page Google sent nothing for is no trouble', () => {
  assert.deepEqual(toSearchResults('recursion', [[], [], [], []]), [])
  assert.deepEqual(toSearchResults('recursion', [[{}]]), [])
})

///////////////////////////////////////////////////////////////////////////////
// The order, which is the other half of #138: the novel is 23rd of the
// title-restricted results, behind twenty books on recursion theory.

test('the book called what was searched for comes first', () => {
  const results = toSearchResults('recursion', [[theTextbook, theNovel]])

  assert.deepEqual(
    results.map((r) => r.title),
    [
      'Recursion: A Novel [Blake Crouch]',
      'Recursion Theory [Joseph R. Shoenfield]',
    ],
  )
})

test('an exact title outranks a title that merely starts with the query', () => {
  assert.equal(matchRank('recursion', theNovel.volumeInfo), 0)
  assert.equal(matchRank('recursion', theTextbook.volumeInfo), 1)
  assert.equal(matchRank('recursion', aJournal.volumeInfo), 2)
})

test('the subtitle counts as part of the title, typed or not', () => {
  assert.equal(matchRank('Recursion: A Novel', theNovel.volumeInfo), 0)
  assert.equal(matchRank('recursion a novel', theNovel.volumeInfo), 0)
})

test('case, punctuation and spacing are not what anyone searches by', () => {
  assert.equal(normalizeTitle('  Recursion:  A Novel! '), 'recursion a novel')
  assert.equal(normalizeTitle(undefined), '')
  assert.equal(matchRank('RECURSION', theNovel.volumeInfo), 0)
})

test('a query that begins a title is not the same as one that appears in it', () => {
  // "The History of the Hobbit" starts with neither.
  const hobbit = aVolume({ title: 'The Hobbit, Or, There and Back Again' })
  const history = aVolume({ title: 'The History of the Hobbit' })

  assert.equal(matchRank('the hobbit', hobbit.volumeInfo), 1)
  assert.equal(matchRank('the hobbit', history.volumeInfo), 2)
})

test('Google\'s own order is what breaks a tie', () => {
  const first = aVolume({
    ...theNovel.volumeInfo,
    industryIdentifiers: isbns('9780525483601', '0525483608'),
  })
  const results = toSearchResults('recursion', [[first, theNovel]])

  assert.deepEqual(results.map((r) => r.ref), ['9780525483601', '9781524759797'])
})
