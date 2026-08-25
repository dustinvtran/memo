/**
 * @file This file exports parsers which verify that
 * data POSTed by user matches the shape of our data structures.
 *
 * Exports MUST be named after a valid DB collection.
 */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */

/** @typedef {(
 * 'filmEntries' | 'gameEntries' | 'tvShowEntries' | 'bookEntries' | 'users' | 'tvShows' | 'films' | 'games' | 'books' | 'bookReviews' | 'gameReviews' | 'tvShowReviews' | 'filmReviews' | 'entryRevisions'
 * )} ValidCollection */

/** @type {Record<ValidCollection, Validator<any>>} */
/*
 * `reviews` is the parser for all four review collections: the shape does not
 * differ by work type, and naming it four times is what makes that visible at
 * the point of use.
 */
export { filmEntries, films } from './films.js'
export { gameEntries, games } from './games.js'
export { tvShowEntries, tvShows } from './tvShows.js'
export { bookEntries, books } from './books.js'
export { users } from './users.js'
export { entryRevisions } from './revisions.js'
export {
  reviews as filmReviews,
  reviews as gameReviews,
  reviews as tvShowReviews,
  reviews as bookReviews,
} from './reviews.js'
