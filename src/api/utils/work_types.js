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
  },
  {
    type: 'tv',
    works: 'tvShows',
    entries: 'tvShowEntries',
    reviews: 'tvShowReviews',
    entryType: 'TVShow',
    apiRefPrefixes: ['tmdb'],
    identityPrefixes: ['tmdb'],
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

module.exports = {
  WORK_TYPES,
  TYPES,
  byType,
  byEntryCollection,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(field: keyof WorkType) => Record<string, WorkType>} */
const indexBy = (field) =>
  Object.fromEntries(WORK_TYPES.map((workType) => [workType[field], workType]))

const BY_TYPE = indexBy('type')
const BY_ENTRY_COLLECTION = indexBy('entries')
