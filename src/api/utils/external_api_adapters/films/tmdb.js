/**
 * @file The film half of the TMDB adapter: which endpoints a film lives on.
 * The rest is ../tmdb_adapter.js, and what a film response maps to is
 * ../tmdb_mapping.js's `FILM_MAPPING`.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/films').Film} Film */
const { tmdbAdapter } = require('../tmdb_adapter')
const { FILM_MAPPING } = require('../tmdb_mapping')

/** @type Adapter */
module.exports = tmdbAdapter({
  mapping: FILM_MAPPING,
  search: (client, query) => client.search.movies({ query: { query } }),
  details: (client, movie_id) => client.movie.getDetails({ pathParameters: { movie_id } }),
  credits: (client, movie_id) => client.movie.getCredits({ pathParameters: { movie_id } }),
})
