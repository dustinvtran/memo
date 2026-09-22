import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGES, PAGE_SIZE, isbnOf, matchRank, normalizeTitle, queriesFor, searchUrls, titleOf, toSearchResult, toSearchListing } from './google_search.js'
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
  // `http://`, which is what Google Books really answers with. It read
  // `https://` until #394, and so the row below could not have caught the
  // scheme going into the database unrewritten.
  imageLinks: { thumbnail: 'http://books.google.com/recursion.jpg' },
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
// The three shapes #387 is about, written to match volumes Google really
// answers with rather than to a remembered idea of one — the fields and the
// two orders below are off the `/volumes` responses recorded in
// docs/API_choices.md, and the `http://books.google.com/books/content?…`
// thumbnails are the form those carry.

/**
 * A scan of a pre-ISBN printing: no `industryIdentifiers` key at all, which is
 * the shape `isbnOf`'s optional chain and `book_ref_proposal.js`'s `?? []` are
 * both written for. ISBNs date from about 1970, so this is every edition of an
 * older book Google holds a scan of rather than a publisher's record.
 */
const aScannedPrinting = aVolume({
  title: 'Moby Dick',
  subtitle: 'Or, The Whale',
  authors: ['Herman Melville'],
  publishedDate: '1851',
  imageLinks: {
    thumbnail: 'http://books.google.com/books/content?id=uDMhAQAAMAAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api',
  },
})

/** A printing Google lists an ISBN-10 for and no ISBN-13. */
const aPaperback = aVolume({
  title: 'Moby-Dick',
  authors: ['Herman Melville'],
  publisher: 'Penguin Classics',
  publishedDate: '2003',
  industryIdentifiers: [{ type: 'ISBN_10', identifier: '0142437247' }],
  imageLinks: {
    thumbnail: 'http://books.google.com/books/content?id=PZiUy2lSgU0C&printsec=frontcover&img=1&zoom=1&source=gbs_api',
  },
})

/**
 * Both ISBNs, the ISBN-10 first — copied from the `A Wild Sheep Chase` volume
 * in docs/API_choices.md, because the order is the point and it is not fixed:
 * the same title comes back ISBN-13 first under one volume id and ISBN-10
 * first under another. `isbnOf` takes whichever is listed first either way.
 */
const aReissue = aVolume({
  title: 'A Wild Sheep Chase',
  subtitle: 'Special 3D Edition',
  authors: ['Haruki Murakami'],
  publisher: 'Vintage Classic',
  publishedDate: '2015-08-06',
  industryIdentifiers: [
    { type: 'ISBN_10', identifier: '1784870153' },
    { type: 'ISBN_13', identifier: '9781784870157' },
  ],
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

test("a row's cover is served over TLS, whatever scheme Google offered", () => {
  // The CSP allows any host over `https:` and none over `http:`, so a row that
  // carried Google's own scheme through would be blocked. #394.
  assert.equal(
    toSearchResult(theNovel.volumeInfo).imageUrl,
    'https://books.google.com/recursion.jpg',
  )
  assert.equal(toSearchResult(theTextbook.volumeInfo).imageUrl, undefined)
})

test('a volume Google has no ISBN for is not offered', () => {
  // `retrieve` looks a book up by its ISBN, so there would be nothing to fetch.
  assert.deepEqual(toSearchListing('recursion', [[aJournal]]).results, [])
})

test('an ISBN-10 is a ref like any other when it is all Google lists', () => {
  assert.equal(isbnOf(aPaperback.volumeInfo), '0142437247')
  assert.equal(isbnOf(aReissue.volumeInfo), '1784870153')
  assert.equal(isbnOf(aScannedPrinting.volumeInfo), undefined)
})

///////////////////////////////////////////////////////////////////////////////
// What was left out, which is #387: a book with no ISBN cannot be filed under
// one, and until now leaving it out was indistinguishable from not finding it.

test('a volume with no identifiers at all is counted, not merely dropped', () => {
  const listing = toSearchListing('moby dick', [[aScannedPrinting, aPaperback]])

  assert.deepEqual(listing.results.map((r) => r.ref), ['0142437247'])
  assert.deepEqual(listing.discarded, { noRef: 1, duplicateRef: 0 })
})

test('identifiers that are not ISBNs are no ref either', () => {
  // A scan carries a library's own number. It is an identifier and it is not
  // one anything here can retrieve a book by.
  const listing = toSearchListing('recursion', [[aJournal, theNovel]])

  assert.deepEqual(listing.discarded, { noRef: 1, duplicateRef: 0 })
})

test('a search that finds five and can offer three says which', () => {
  // The #343 case: the edition that had to be linked to was not in the list,
  // and a list of four reads as a search that found four.
  const found = [aScannedPrinting, theNovel, aScannedPrinting, aPaperback, aReissue]
  const listing = toSearchListing('recursion', [found])

  assert.equal(listing.results.length, 3)
  assert.deepEqual(listing.discarded, { noRef: 2, duplicateRef: 0 })
})

test('a search whose every answer is unfilable is not a search with no answers', () => {
  const listing = toSearchListing('moby dick', [[aScannedPrinting], [aScannedPrinting, aJournal]])

  assert.deepEqual(listing.results, [])
  assert.deepEqual(listing.discarded, { noRef: 3, duplicateRef: 0 })
})

test('a search that dropped nothing reports nothing dropped', () => {
  const { results, discarded } = toSearchListing('recursion', [[theNovel, theTextbook]])

  assert.equal(results.length, 2)
  assert.deepEqual(discarded, { noRef: 0, duplicateRef: 0 })
})

test('an empty search still carries the counts, at zero', () => {
  assert.deepEqual(
    toSearchListing('recursion', [[], []]),
    { results: [], discarded: { noRef: 0, duplicateRef: 0 } },
  )
})

test('an edition that came back from both queries is offered once', () => {
  // Counted apart from the volumes with no ISBN: collapsing the same edition
  // is what the dedupe is for, and so is collapsing two editions that share an
  // ISBN pairing. Neither is a book nobody can see.
  const { results, discarded } =
    toSearchListing('recursion', [[theNovel], [theNovel, theTextbook]])

  assert.deepEqual(results.map((r) => r.ref), ['9781524759797', '9781315077871'])
  assert.deepEqual(discarded, { noRef: 0, duplicateRef: 1 })
})

test('a page Google sent nothing for is no trouble', () => {
  assert.deepEqual(toSearchListing('recursion', [[], [], [], []]).results, [])
  assert.deepEqual(toSearchListing('recursion', [[{}]]).results, [])
})

///////////////////////////////////////////////////////////////////////////////
// The order, which is the other half of #138: the novel is 23rd of the
// title-restricted results, behind twenty books on recursion theory.

test('the book called what was searched for comes first', () => {
  const { results } = toSearchListing('recursion', [[theTextbook, theNovel]])

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
  const { results } = toSearchListing('recursion', [[first, theNovel]])

  assert.deepEqual(results.map((r) => r.ref), ['9780525483601', '9781524759797'])
})
