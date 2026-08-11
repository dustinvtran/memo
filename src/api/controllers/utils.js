/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../errors').Error} Error */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
const { Result, ResultAsync, err, ok } = require('neverthrow')
const { match } = require('ts-pattern')
const errors = require('../utils/errors')
const db = require('../utils/db')
const { validateExists } = require('../utils/general')
const { JWT } = require("jose")

/** @type {(event: Event) => Result<string, Error>} */
const getUserId = (event) =>
   validateExists(event.headers?.authorization)
    .map((authString) => authString.replace('Bearer ', ''))
    .map((jwt) => JWT.verify(jwt, process.env.TOKEN_SECRET).sub)
    .mapErr(errors.unauthorized)

/** @type {(segmentIndex: number, event: Event) => string} */
const getSegment = (segmentIndex, event) =>
  getUrlSegments(event)[segmentIndex]

/** @type {(event: Event) => string[]} */
const getUrlSegments = (event) =>
  event.path
    .replace(/\.netlify\/functions\/[^/]+/, '')
    .replace(/api\/[^/]+/, '')
    .split('/')
    .filter((s) => s)

/** @type {(event: Event) => Result<any, Error>} */
const getReqBody = Result.fromThrowable(
  (event) => JSON.parse(event.body),
  (err) => errors.req(String(err)),
)

/** @type {(name: string) => ResultAsync<string, Error>} */
const findIdOfName = (name) =>
  db.findOneByField_('users', 'username', name)
    .map(result => result?.data?.userId)

/**
 * The `:type` URL segment every entry-scoped route starts with.
 * @type {(segment: string) => Result<ValidCollection, Error>}
 */
const toEntryCollection = (segment) =>
  match(segment)
    .with('films', () => ok('filmEntries'))
    .with('books', () => ok('bookEntries'))
    .with('tv', () => ok('tvShowEntries'))
    .with('games', () => ok('gameEntries'))
    .otherwise(() => err(errors.notFound()))

/**
 * The inverse of toEntryCollection, for the code that has a collection in
 * hand rather than a URL.
 * @type {(entryCollection: ValidCollection) => string | undefined}
 */
const toEntryType = (entryCollection) => ({
  filmEntries: 'films',
  bookEntries: 'books',
  tvShowEntries: 'tv',
  gameEntries: 'games',
}[entryCollection])

/**
 * An entry's review lives in the collection of the same name, with
 * `Entries` swapped for `Reviews`.
 * @type {(entryCollection: ValidCollection) => ValidCollection}
 */
const toReviewCollection = (entryCollection) =>
  /** @type any */ (entryCollection.replace('Entries', 'Reviews'))

module.exports = {
  getUserId,
  getSegment,
  getUrlSegments,
  getReqBody,
  findIdOfName,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
}

