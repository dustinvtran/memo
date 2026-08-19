/**
 * @file The parsers for a *partial* update, keyed by collection the way
 * ./index.js is.
 *
 * ./index.js holds the full-document parsers `_create` runs, and its contract
 * is that a name there is a collection you can insert into. These are the
 * other half: what a client is allowed to change about a document that already
 * exists. Only the entry collections have one, because they are the only
 * documents a request body is allowed to rewrite wholesale — a username, a
 * biography and a draft are each a single named field, validated where they
 * are read.
 *
 * `entryUpdateParser` in ./entries.js says what these permit and, more to the
 * point, what they drop.
 */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
/** @typedef {import('./index').ValidCollection} ValidCollection */

/** @type {Record<string, Validator<any>>} */
module.exports = {
  filmEntries: require('./films').filmEntryUpdates,
  gameEntries: require('./games').gameEntryUpdates,
  tvShowEntries: require('./tvShows').tvShowEntryUpdates,
  bookEntries: require('./books').bookEntryUpdates,
}
