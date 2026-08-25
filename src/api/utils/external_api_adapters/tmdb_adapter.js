/**
 * @file The TMDB adapter, written once.
 *
 * films/tmdb.js and tv_shows/tmdb.js were 83 and 90 lines that differed in
 * about twelve, `toError` included — byte for byte, comment and all. What is
 * actually per-type is ./tmdb_mapping.js's two mappings and the three client
 * calls each file hands `tmdbAdapter` below.
 *
 * The client is built here, at require time, which is why neither this module
 * nor anything requiring it can be reached by the test suite. The mapping is
 * next door and dependency-free for that reason.
 */
/** @typedef {import('./types').Adapter} Adapter */
/** @typedef {import('./types').SearchFunction} SearchFunction */
/** @typedef {import('./types').SearchResult} SearchResult */
/** @typedef {import('./tmdb_mapping').Mapping} Mapping */
/** @typedef {import('../errors').Error} Error */
const tmdb = require('node-themoviedb')
const { ResultAsync } = require('neverthrow')
const errors = require('../errors')
const { match } = require('ts-pattern')
const { throwIt } = require('../general')
const { retrying, describeFailure, publicFailure, statusOf } = require('./retry')
const { toSearchResults, toWork } = require('./tmdb_mapping')

const { TMDB_API_KEY } = process.env

/**
 * Built on the first search rather than while this module is read.
 *
 * At import time a missing key took down the cold start of every route that
 * reaches this file, before any handler existed to report it — the same
 * complaint `games/igdb.js` records a few lines into itself. It also meant
 * the suite could not load the module at all without a key, which is why
 * `works.test.js` used to intercept the adapter index through `Module._load`.
 * Failing on the request that needs the key is both the honest moment and
 * the one a test can reach.
 */
let client

/** @type {() => any} */
const tmdbClient = () =>
  (client ??= new tmdb(TMDB_API_KEY ?? throwIt('TMDB_API_KEY is not set.')))

/**
 * The three endpoints a media type answers on. Each takes the client rather
 * than closing over it so that a caller names the method and its path
 * parameter and nothing else — `movie_id` and `tv_id` are the same id under
 * two names.
 *
 * @typedef {object} Endpoints
 * @property {(client: any, query: string) => Promise<any>} search
 * @property {(client: any, ref: string) => Promise<any>} details
 * @property {(client: any, ref: string) => Promise<any>} credits
 */

/**
 * An adapter for one TMDB media type. `retrieve` asks for the details and the
 * credits together and retries the pair, because a work needs both and half of
 * one is not worth returning.
 * @type {(config: Endpoints & { mapping: Mapping }) => Adapter}
 */
const tmdbAdapter = ({ mapping, search, details, credits }) => {
  const toError = tmdbError(mapping.notFoundMessage)

  return {
    search: (titleSearch) => ResultAsync.fromPromise(
      retrying(() => search(tmdbClient(), titleSearch))
        .then(({ data }) => toSearchResults(mapping, data)),
      toError
    ),

    retrieve: (ref) => ResultAsync.fromPromise(
      retrying(() => Promise.all([
        details(tmdbClient(), ref),
        credits(tmdbClient(), ref),
      ]))
        .then(([{ data }, { data: castAndCrew }]) =>
          toWork(mapping, ref, data, castAndCrew)
        ),
      toError,
    ),
  }
}

module.exports = {
  tmdbAdapter,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * `statusOf` rather than `err.errorCode`, because node-themoviedb only wraps
 * the statuses it has a class for and throws `got`'s own error through for
 * the rest — including the 5xx that `retrying` has just given up on.
 *
 * The 404 line is the only one the two media types worded differently, so it
 * is the only thing this takes: telling someone who asked after a show that
 * there is no such film would be worse than saying nothing.
 * @type {(notFoundMessage: string) => (err: any) => Error}
 */
const tmdbError = (notFoundMessage) => (err) => match(statusOf(err))
  .with(404, () => errors.notFound(undefined, notFoundMessage))
  .with(401, () => errors.unauthorized(describeFailure(err), publicFailure('tmdb', err)))
  .with(408, () => errors.internal(undefined, 'tmdb timed out'))
  // Everything tmdb said goes to the log; the caller gets the class of the
  // failure, which is the part that is theirs to act on. #105.
  .otherwise(() => errors.internal(
    `tmdb failed: ${describeFailure(err)}`,
    publicFailure('tmdb', err),
  ))
