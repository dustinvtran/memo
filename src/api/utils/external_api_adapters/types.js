/** @typedef {import('../errors').Error} Error */
/** @typedef {import('../parsers/films').Film} Film */
/** @typedef {import('../parsers/games').Game} Game */
/** @typedef {import('../parsers/books').Book} Book */
/** @typedef {import('../parsers/tvShows').TVShow} TVShow */
import { ResultAsync } from 'neverthrow'
/** @typedef {object} Adapter
 * @property {SearchFunction} search
 * @property {RetrieveFunction} retrieve
 */

/**
 * @typedef {object} SearchResult
 * @property {string} title
 * @property {string} ref
 * @property {string} [year]
 * @property {string} [imageUrl]
 */

/**
 * What a search answers with: the rows to offer, and — where an adapter can
 * find something it is unable to offer — a count of what it left out and why.
 * Books is the only one of the four so far: a book is filed under its ISBN,
 * and Google answers with volumes it holds no ISBN for. The rows live under a
 * name rather than being the body itself so that the counts have somewhere to
 * be, which is the same shape `/api/entries/versions` uses for its list. #387.
 *
 * `noRef` counts candidates the adapter has no ref for and so cannot offer;
 * `duplicateRef` counts ones collapsed into a row already in `results`, which
 * is ordinary deduplication and not a loss.
 * @typedef {object} SearchListing
 * @property {SearchResult[]} results
 * @property {{ noRef: number, duplicateRef: number }} [discarded]
 */

/** @typedef {(query: string) => ResultAsync<SearchListing, Error>} SearchFunction */

/** @typedef {(ref: string) => ResultAsync<Film, Error>} FilmRetrieveFunction */

/** @typedef {(ref: string) => ResultAsync<Game, Error>} GameRetrieveFunction */

/** @typedef {(ref: string) => ResultAsync<Book, Error>} BookRetrieveFunction */

/** @typedef {(ref: string) => ResultAsync<TVShow, Error>} TVShowRetrieveFunction */

/** @typedef {(
 * | FilmRetrieveFunction
 * | GameRetrieveFunction
 * | BookRetrieveFunction
 * | TVShowRetrieveFunction
 * )} RetrieveFunction
 */
