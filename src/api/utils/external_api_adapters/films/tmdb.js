/**
 * @file The film half of the TMDB adapter: which endpoints a film lives on.
 * The rest is ../tmdb_adapter.js, and what a film response maps to is
 * ../tmdb_mapping.js's `FILM_MAPPING`.
 *
 * Exported by name, like the other three adapters, so that the two ways into
 * this file agree. `require` of an ES module hands back the namespace and
 * does not unwrap a lone `default`, so while this ended in
 * `export default tmdbAdapter(…)` the CommonJS caller in
 * src/db_maintenance/scripts/backfill_work_metadata.js got
 * `{ __esModule, default }` and `adapter.retrieve` was `undefined`. #252.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/films').Film} Film */
import { tmdbAdapter } from '../tmdb_adapter.js'
import { FILM_MAPPING } from '../tmdb_mapping.js'

/** @type {Adapter} */
const adapter = tmdbAdapter({
  mapping: FILM_MAPPING,
  search: (client, query) => client.search.movies({ query: { query } }),
  details: (client, movie_id) => client.movie.getDetails({ pathParameters: { movie_id } }),
  credits: (client, movie_id) => client.movie.getCredits({ pathParameters: { movie_id } }),
})

const { search, retrieve } = adapter

export {
  search,
  retrieve
}
