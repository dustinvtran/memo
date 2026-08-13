/**
 * @file The tv half of the TMDB adapter: which endpoints a show lives on.
 * The rest is ../tmdb_adapter.js, and what a show response maps to is
 * ../tmdb_mapping.js's `TV_SHOW_MAPPING`.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../../parsers/tvShows').TVShow} TVShow */
const { tmdbAdapter } = require('../tmdb_adapter')
const { TV_SHOW_MAPPING } = require('../tmdb_mapping')

/** @type Adapter */
module.exports = tmdbAdapter({
  mapping: TV_SHOW_MAPPING,
  search: (client, query) => client.search.TVShows({ query: { query } }),
  details: (client, tv_id) => client.tv.getDetails({ pathParameters: { tv_id } }),
  credits: (client, tv_id) => client.tv.getCredits({ pathParameters: { tv_id } }),
})
