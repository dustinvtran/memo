/**
 * @file The tv half of the TMDB adapter: which endpoints a show lives on.
 * The rest is ../tmdb_adapter.js, and what a show response maps to is
 * ../tmdb_mapping.js's `TV_SHOW_MAPPING`.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/tvShows').TVShow} TVShow */
import { tmdbAdapter } from '../tmdb_adapter.js'
import { TV_SHOW_MAPPING } from '../tmdb_mapping.js'
/** @type Adapter */
export default tmdbAdapter({
  mapping: TV_SHOW_MAPPING,
  search: (client, query) => client.search.TVShows({ query: { query } }),
  details: (client, tv_id) => client.tv.getDetails({ pathParameters: { tv_id } }),
  credits: (client, tv_id) => client.tv.getCredits({ pathParameters: { tv_id } }),
})
