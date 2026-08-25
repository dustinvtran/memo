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
 * that: `queriesFor`, `searchUrls` and the sort in `toSearchResults`.
 */

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
  imageUrl: volumeInfo?.imageLinks?.thumbnail,
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
 * The first of `xs` under each key, keys of `undefined` dropped — which is how
 * a volume Google holds no ISBN for leaves the results.
 * @type {<T>(xs: T[], key: (x: T) => any) => T[]}
 */
const dedupedBy = (xs, key) => {
  const seen = new Set()

  return xs.filter((x) => {
    const k = key(x)
    if (k === undefined || seen.has(k)) return false
    seen.add(k)
    return true
  })
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
 * The search results for `pages` of Google volumes, in the order they should
 * be shown: the books whose title is what was typed, then the ones whose title
 * starts with it, then the rest, each group in the order Google gave it.
 *
 * That sort is what puts Blake Crouch's "Recursion" on screen. It is 23rd of
 * the title-restricted results, behind twenty books called "Recursion Theory"
 * and the like, and an exact title match outranks every one of them.
 *
 * A volume with no ISBN is dropped rather than shown, because `retrieve` looks
 * a book up by its ISBN and there would be nothing to fetch. Volumes are
 * deduplicated by it too — the same edition comes back from both queries.
 * @type {(titleSearch: string, pages: any[][]) => object[]}
 */
const toSearchResults = (titleSearch, pages) =>
  byTitleMatch(
    titleSearch,
    dedupedBy(pages.flat().map((volume) => volume?.volumeInfo), isbnOf)
  )
    .map(toSearchResult)

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
  toSearchResults,
}