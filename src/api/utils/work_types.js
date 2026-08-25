/**
 * @file The one description of what a work type is made of: the `:type`
 * segment its urls start with, the three collections that hold it, the
 * `entryType` its documents carry, and the apiRef prefixes its works are
 * cached under.
 *
 * This mapping used to be written out by hand wherever it was needed — as a
 * ts-pattern match in `controllers/utils.js`, as object literals in
 * `controllers/reviews.js`, `controllers/works.js` and `db/unsafe_functions.js`,
 * and once as `collection.replace('Entries', 'Reviews')`. Adding a type meant
 * finding all of them, and a missed one failed at a different depth depending
 * on which it was: a clean 404 from one, `undefined` and a Mongo error from
 * the next.
 *
 * Deliberately pure and dependency-free (no neverthrow, no ts-pattern, no
 * database), so it is covered by `node --test` without an install — see
 * work_types.test.js. The callers that need a `Result` wrap these lookups;
 * they don't return one.
 */

/** @typedef {import('./parsers').ValidCollection} ValidCollection */

/**
 * @typedef {{
 *   type: string,
 *   works: ValidCollection,
 *   entries: ValidCollection,
 *   reviews: ValidCollection,
 *   entryType: string,
 *   apiRefPrefixes: string[],
 *   identityPrefixes: string[],
 *   refShape: 'id' | 'isbn',
 * }} WorkType
 */

/**
 * In the order the lists are exported, which is the order the site presents
 * them in.
 *
 * `apiRefPrefixes` lists every prefix a cached work of this type may
 * legitimately carry, most canonical first. `identityPrefixes` is the subset
 * of those that actually names the work, and so the only ones a lookup by
 * external id may use — they are not always the same list.
 *
 * `refShape` names the shape of the id that follows the prefix, which is what
 * `parseRef` checks a url segment against — see REF_SHAPES.
 *
 * @type {WorkType[]}
 */
const WORK_TYPES = [
  {
    type: 'films',
    works: 'films',
    entries: 'filmEntries',
    reviews: 'filmReviews',
    entryType: 'Film',
    apiRefPrefixes: ['tmdb'],
    identityPrefixes: ['tmdb'],
    refShape: 'id',
  },
  {
    type: 'tv',
    works: 'tvShows',
    entries: 'tvShowEntries',
    reviews: 'tvShowReviews',
    entryType: 'TVShow',
    apiRefPrefixes: ['tmdb'],
    identityPrefixes: ['tmdb'],
    refShape: 'id',
  },
  {
    type: 'games',
    works: 'games',
    entries: 'gameEntries',
    reviews: 'gameReviews',
    entryType: 'Game',
    // `hltb` is a legacy secondary ref: the adapter used to add it alongside
    // `igdb`, and 775 games still carry one. HowLongToBeat's API is gone so no
    // new ones are written, but the pages are still worth linking to. Only
    // `igdb` can be used to re-retrieve the work.
    apiRefPrefixes: ['igdb', 'hltb'],
    // An hltb id identifies a HowLongToBeat page, not the game, and plenty of
    // games share the placeholder `hltb__N/A`. Only igdb establishes identity,
    // so only igdb may be looked up by.
    identityPrefixes: ['igdb'],
    refShape: 'id',
  },
  {
    type: 'books',
    works: 'books',
    entries: 'bookEntries',
    reviews: 'bookReviews',
    entryType: 'Book',
    // The Google Books adapter caches books under `ISBN__`; `google__` is also
    // accepted because some book documents are stored under that name. Both
    // name the same ISBN.
    apiRefPrefixes: ['ISBN', 'google'],
    // Both name the same ISBN, so either establishes identity.
    identityPrefixes: ['ISBN', 'google'],
    refShape: 'isbn',
  },
]

/** The `:type` url segments, in the same order. */
const TYPES = WORK_TYPES.map((workType) => workType.type)

/**
 * The type a `:type` url segment names, or undefined if it names none. The
 * callers decide what an unknown segment costs — `controllers/utils.js` turns
 * it into a 404.
 * @type {(type: string) => WorkType | undefined}
 */
const byType = (type) => BY_TYPE[type]

/**
 * The same row, for the code that has an entry collection in hand rather than
 * a url.
 * @type {(entryCollection: string) => WorkType | undefined}
 */
const byEntryCollection = (entryCollection) => BY_ENTRY_COLLECTION[entryCollection]

/**
 * The external id a `/works/retrieve/:type/:ref` segment names, or undefined
 * if it names nothing a work of that type could be held under. An unknown type
 * has no shape to check against, so it answers undefined as well — the same
 * answer `byType` gives it, and `controllers/works.js` turns both into the 404
 * it already answers an unknown type with.
 *
 * The segment is not decoration. The games adapter interpolates it into an
 * apicalypse `where id = <ref>` clause and the books adapter into a Google
 * Books query string carrying GOOGLE_API_KEY, so until #175 a caller wrote
 * part of both. Checking the shape here, where the segment is read, is what
 * saves three adapters from each deciding for themselves what a safe ref is.
 *
 * Returns the segment itself rather than a number: each accepted shape is
 * already the canonical spelling, so there is nothing to normalise, and the
 * adapters and the `<prefix>__<ref>` lookups all want a string.
 *
 * @type {(type: string, segment: string) => string | undefined}
 */
const parseRef = (type, segment) => {
  const shape = REF_SHAPES[byType(type)?.refShape]
  return shape?.test(segment) ? segment : undefined
}

export {
  WORK_TYPES,
  TYPES,
  byType,
  byEntryCollection,
  parseRef,
}
///////////////////////////////////////////////////////////////////////////////

/**
 * What an id of each shape looks like: as the two APIs write them, and as
 * every one of the 3794 identity refs in the four works collections — 2034
 * tmdb, 1128 igdb, 632 ISBN — is spelled.
 *
 * A trailing `$` would not be the end of it — `$` also matches before a final
 * newline, and `%0A` in a url is a newline once `decodeURI` has had it, an
 * `id = 1020\n...` being just the sort of segment this exists to refuse.
 * `(?![\s\S])` is "and then nothing whatsoever".
 */
const REF_SHAPES = {
  // A tmdb or igdb id. Leading zeros are refused rather than tolerated:
  // neither API writes one, so `tmdb__007` could only be a cache miss that
  // then asks tmdb for a work we would go on to cache a second time.
  id: /^[1-9][0-9]*(?![\s\S])/,
  // ISBN-13, or an ISBN-10 whose check digit may be an X. Unpunctuated and
  // uppercase, because that is how Google Books writes the identifiers in the
  // search results a ref is taken from, and so how every book is cached.
  isbn: /^(?:[0-9]{9}[0-9X]|[0-9]{13})(?![\s\S])/,
}

/** @type {(field: keyof WorkType) => Record<string, WorkType>} */
const indexBy = (field) =>
  Object.fromEntries(WORK_TYPES.map((workType) => [workType[field], workType]))

const BY_TYPE = indexBy('type')
const BY_ENTRY_COLLECTION = indexBy('entries')
