/**
 * @file The film half of the TMDB adapter: which endpoints a film lives on.
 * The rest is ../tmdb_adapter.js, and what a film response maps to is
 * ../tmdb_mapping.js's `FILM_MAPPING`.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/films').Film} Film */
import { tmdbAdapter } from '../tmdb_adapter.js'
import { FILM_MAPPING } from '../tmdb_mapping.js'
/** @type Adapter */
export default tmdbAdapter({
  mapping: FILM_MAPPING,
  search: (client, query) => client.search.movies({ query: { query } }),
  details: (client, movie_id) => client.movie.getDetails({ pathParameters: { movie_id } }),
  credits: (client, movie_id) => client.movie.getCredits({ pathParameters: { movie_id } }),
})
