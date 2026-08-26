/**
 * @file The tv half of the TMDB adapter: which endpoints a show lives on.
 * The rest is ../tmdb_adapter.js, and what a show response maps to is
 * ../tmdb_mapping.js's `TV_SHOW_MAPPING`.
 *
 * Exported by name for the reason ../films/tmdb.js gives: a default export
 * meant one thing to the ESM index next door and another to the CommonJS
 * script that requires this file. #252.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/tvShows').TVShow} TVShow */
import { tmdbAdapter } from '../tmdb_adapter.js'
import { TV_SHOW_MAPPING } from '../tmdb_mapping.js'

/** @type {Adapter} */
const adapter = tmdbAdapter({
  mapping: TV_SHOW_MAPPING,
  search: (client, query) => client.search.TVShows({ query: { query } }),
  details: (client, tv_id) => client.tv.getDetails({ pathParameters: { tv_id } }),
  credits: (client, tv_id) => client.tv.getCredits({ pathParameters: { tv_id } }),
})

const { search, retrieve } = adapter

export {
  search,
  retrieve
}
