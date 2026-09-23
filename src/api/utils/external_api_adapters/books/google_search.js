/**
 * @file What a book search asks Google Books for, and what it makes of the
 * answers.
 *
 * Pure and dependency-free for the reason ../tmdb_mapping.js is: ./google.js
 * is axios and a network call, and everything that decides which books a
 * search comes back with — and in what order — lives here where the suite can
 * reach it.
 *
 * Searching "recursion" used to answer with eleven books on recursion theory
 * and nothing else, which read as "the novel isn't in the database"; the same
 * search typed as "recursion blake crouch" found it at the top. #138. Google
 * ranks a bare keyword against the whole of a book's text, so a 2019 novel
 * loses to every monograph with the word in its index. Three things come of
 * that: `queriesFor`, `searchUrls` and the sort in `toSearchListing`.
 */
import { httpsUrl } from './google_mapping.js'

/**
 * Google caps a response at 20 volumes however large `maxResults` is — the
 * old search asked for 40 and was answered with 20 every time — so more than
 * a page's worth means asking for more than one page.
 */
const PAGE_SIZE = 20

/** Pages of each query. 80 candidates in, somewhere near 50 out. */
const PAGES = 2

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes'

/**
 * The ISBN a book is stored and retrieved under. Google reports ISBN_10 and
 * ISBN_13 for most volumes and one or the other for the rest; whichever comes
 * first is what has always been used, and changing that would file new books
 * under a different `apiRef` from the ones already in the database.
 * @type {(volumeInfo: any) => string | undefined}
 */
const isbnOf = (volumeInfo) =>
  volumeInfo?.industryIdentifiers
    ?.find((identifier) => identifier?.type?.includes('ISBN'))
    ?.identifier

/**
 * A book's title as it is shown and matched on. The subtitle is in it because
 * a search now answers with enough books that "Sapiens" eight times over is
 * not a list anyone can pick from, and Google files "A Brief History of
 * Humankind" separately.
 * @type {(volumeInfo: any) => string}
 */
const titleOf = (volumeInfo) =>
  [volumeInfo?.title, volumeInfo?.subtitle].filter((part) => part).join(': ')

/** @type {(volumeInfo: any) => object} */
const toSearchResult = (volumeInfo) => ({
  title: `${titleOf(volumeInfo)} [${volumeInfo?.authors?.join(', ')}]`,
  year: volumeInfo?.publishedDate?.substring(0, 4),
  ref: isbnOf(volumeInfo),
  imageUrl: httpsUrl(volumeInfo?.imageLinks?.thumbnail),
})

/**
 * Punctuation, case and spacing are not what anyone is searching by:
 * "Recursion: A Novel" and "recursion - a novel" are one title typed twice.
 * @type {(title: any) => string}
 */
const normalizeTitle = (title) =>
  String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * 0 for a title that is the query, 1 for one that begins with it, 2 for the
 * rest.
 *
 * Measured against the volume's own title rather than the row's, which carries
 * the authors too — and against it both with and without its subtitle, so that
 * "sapiens" is an exact match for "Sapiens: A Brief History of Humankind" and
 * so is the whole thing typed out.
 * @type {(titleSearch: string, volumeInfo: any) => number}
 */
const matchRank = (titleSearch, volumeInfo) => {
  const query = normalizeTitle(titleSearch)
  if (!query) return 2

  return Math.min(...[volumeInfo?.title, titleOf(volumeInfo)].map((title) => {
    const normalized = normalizeTitle(title)
    if (normalized === query) return 0
    return normalized.startsWith(`${query} `) ? 1 : 2
  }))
}

/**
 * Sorted by `matchRank` and stable within a rank, so Google's own ordering is
 * what breaks ties. The rank is computed once per volume rather than once per
 * comparison.
 * @type {(titleSearch: string, volumeInfos: any[]) => any[]}
 */
const byTitleMatch = (titleSearch, volumeInfos) =>
  volumeInfos
    .map((volumeInfo) => ({ volumeInfo, rank: matchRank(titleSearch, volumeInfo) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ volumeInfo }) => volumeInfo)

/**
 * The first of `xs` under each key, and a count of what that cost: the ones
 * the key answered `undefined` for, which is how a volume Google holds no ISBN
 * for leaves the results, and the ones repeating a key already seen.
 *
 * The two are counted apart because they are not the same event. A repeat is
 * the same edition arriving from both queries, and collapsing it is the whole
 * point; a volume with no key is a book the search found and cannot offer. A
 * single number would read as "9 results, 5 duplicates" either way. #387.
 * @type {<T>(xs: T[], key: (x: T) => any) => { kept: T[], noKey: number, duplicate: number }}
 */
const dedupedBy = (xs, key) => {
  const seen = new Set()
  const kept = []
  let noKey = 0
  let duplicate = 0

  for (const x of xs) {
    const k = key(x)
    if (k === undefined) {
      noKey += 1
    } else if (seen.has(k)) {
      duplicate += 1
    } else {
      seen.add(k)
      kept.push(x)
    }
  }

  return { kept, noKey, duplicate }
}

/**
 * The search runs twice: once restricted to titles and once as typed. The
 * title-restricted one is what has the novel in it at all, and the plain one
 * still carries the searches that aren't titles — an author's name, a phrase
 * off the cover.
 *
 * The whole query goes inside the quotes because `intitle:` binds to the token
 * after it and nothing else: `intitle:the hobbit` asks for "the" in a title
 * and "hobbit" anywhere, where `intitle:"the hobbit"` asks what the user
 * meant. Quotes the user typed come out first — they would close ours early.
 * @type {(titleSearch: string) => string[]}
 */
const queriesFor = (titleSearch) => [
  `intitle:"${titleSearch.replace(/"/g, ' ')}"`,
  titleSearch,
]

/**
 * Both queries, `PAGES` pages of each, in the order their results should be
 * offered: the title-restricted ones first.
 *
 * `printType=books` keeps journals and magazines out. They carry no ISBN and
 * are dropped below anyway, but they were dropped *after* Google had spent a
 * page's worth of results on them — "Bulletin of the American Mathematical
 * Society" cost as much of a search for "recursion" as a book did.
 * @type {(titleSearch: string, urlSuffix?: string) => string[]}
 */
const searchUrls = (titleSearch, urlSuffix = '') =>
  queriesFor(titleSearch).flatMap((query) =>
    Array.from({ length: PAGES }, (_, page) =>
      `${BASE_URL}?q=${encodeURIComponent(query)}` +
      `&printType=books&maxResults=${PAGE_SIZE}` +
      `&startIndex=${page * PAGE_SIZE}${urlSuffix}`
    )
  )

/**
 * What a search found: the rows to offer, and what was left out getting to
 * them.
 *
 * The rows are in the order they should be shown — the books whose title is
 * what was typed, then the ones whose title starts with it, then the rest,
 * each group in the order Google gave it. That sort is what puts Blake
 * Crouch's "Recursion" on screen. It is 23rd of the title-restricted results,
 * behind twenty books called "Recursion Theory" and the like, and an exact
 * title match outranks every one of them.
 *
 * A volume with no ISBN is still dropped rather than shown, because for a book
 * the ISBN *is* the ref — `retrieve` looks one up by it and a row offering
 * anything else would be filed under an `apiRef` no other book here carries.
 * What changed with #387 is that the dropping is now reported: `discarded.noRef`
 * counts them, so "Google has four editions" and "Google has nine and five
 * cannot be filed" are different answers rather than the same list of four.
 *
 * Nothing about the *count* makes a book selectable, which is the point of
 * keeping it a count: two populations lose their editions this way for reasons
 * that have nothing to do with the book — anything printed before ISBNs
 * existed, and anything Google holds a scan of rather than a publisher's
 * record — and knowing that one of them is what a search hit is the difference
 * between a missing edition and a missing feature. #343 is where that was paid
 * for: the edition a book had to be linked to was not in the candidate list,
 * and nothing said so.
 *
 * `discarded.duplicateRef` is the other half and is deliberately separate: the
 * same edition arrives from both queries, and collapsing it is what the dedupe
 * is *for*.
 * @type {(titleSearch: string, pages: any[][]) => { results: object[], discarded: { noRef: number, duplicateRef: number } }}
 */
const toSearchListing = (titleSearch, pages) => {
  const { kept, noKey, duplicate } =
    dedupedBy(pages.flat().map((volume) => volume?.volumeInfo), isbnOf)

  return {
    results: byTitleMatch(titleSearch, kept).map(toSearchResult),
    discarded: { noRef: noKey, duplicateRef: duplicate },
  }
}

export {
  BASE_URL,
  PAGES,
  PAGE_SIZE,
  isbnOf,
  matchRank,
  normalizeTitle,
  queriesFor,
  searchUrls,
  titleOf,
  toSearchResult,
  toSearchListing,
}