/**
 * @file A lot of this code is duplicated
 * with the Film adapter...
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').TVShowRetrieveFunction} TVShowRetrieveFunction */
/** @typedef {import('../../errors').Error} Error */
/** @typedef {import('../../parsers/films').Film} Film */
const tmdb = require('node-themoviedb')
const { ResultAsync } = require('neverthrow')
const errors = require('../../errors')
const { match } = require('ts-pattern')
const { throwIt } = require('../../general')
const { retrying, describeFailure, statusOf } = require('../retry')

const { TMDB_API_KEY } = process.env

const tmdbClient = new tmdb(TMDB_API_KEY ?? throwIt('TMDB_API_KEY is not set.'))

/** @type SearchFunction */
const search = (titleSearch) => ResultAsync.fromPromise(
  retrying(() => tmdbClient.search.TVShows({ query: { query: titleSearch } }))
    .then(({ data }) =>
      data.results.map((result) => ({
        title: result.name,
        year: result.first_air_date?.substring(0,4) || undefined,
        ref: String(result.id),
        imageUrl: result.poster_path
          ? 'https://www.themoviedb.org/t/p/w116_and_h174_face' + result.poster_path
          : undefined
      }))
    ),
  toError
)

/** @type TVShowRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  retrying(() => Promise.all([
    tmdbClient.tv.getDetails({ pathParameters: { tv_id: ref } }),
    tmdbClient.tv.getCredits({ pathParameters: { tv_id: ref } })
  ]))
    .then(([{ data }, { data: credits }]) => ({
      entryType: 'TVShow',
      originalTitle: data.original_name,
      englishTranslatedTitle: data.name,
      releaseYear: parseInt(data.first_air_date?.substring(0, 4)),
      duration: data.episode_run_time?.[0] || undefined,
      imageUrl: data.poster_path ? 'https://www.themoviedb.org/t/p/w300_and_h450_bestv2' + data.poster_path : undefined,
      genres: data.genres.map(g => g.name),
      directors: credits.crew
        .filter((person) => ['Director', 'Series Director'].includes(person.job))
        .map(p => p.name),
      actors: [...credits.cast]
        // @ts-ignore (library typing is wrong)
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 10)
        // @ts-ignore (library typing is wrong)
        .filter((person) => person.popularity > 6)
        .map((person) => person.name),
      apiRefs: [`tmdb__${ref}`],
      externalUrls: [{ name: 'tmdb', url: `https://www.themoviedb.org/tv/${ref}` }],
      episodes: data.seasons.reduce((eps, s) => eps + s.episode_count, 0),
    })),
  toError,
)

/** @type Adapter */
module.exports = {
  search,
  retrieve
}

///////////////////////////////////////////////////////////////////////////////

/**
 * `statusOf` rather than `err.errorCode`, because node-themoviedb only wraps
 * the statuses it has a class for and throws `got`'s own error through for
 * the rest — including the 5xx that `retrying` has just given up on.
 * @type {(err: any) => Error}
 */
const toError = (err) => match(statusOf(err))
  .with(404, () => errors.notFound('tmdb'))
  .with(401, () => errors.unauthorized('tmdb'))
  .with(408, () => errors.internal('tmdb timed out'))
  .otherwise(() => {
    console.error(`tmdb failed: ${describeFailure(err)}`)
    return errors.internal(`tmdb failed (${describeFailure(err)})`)
  })
