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

/** @typedef {(query: string) => ResultAsync<SearchResult[], Error>} SearchFunction */

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
