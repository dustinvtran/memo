/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').FilmRetrieveFunction} FilmRetrieveFunction */
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
  retrying(() => tmdbClient.search.movies({ query: { query: titleSearch } }))
    .then(({ data }) =>
      data.results.map((result) => ({
        title: result.title,
        year: result.release_date?.substring(0,4) || undefined,
        ref: String(result.id),
        imageUrl: result.poster_path
          ? 'https://www.themoviedb.org/t/p/w116_and_h174_face' + result.poster_path
          : undefined
      }))
    ),
  toError
)

/** @type FilmRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  retrying(() => Promise.all([
    tmdbClient.movie.getDetails({ pathParameters: { movie_id: ref } }),
    tmdbClient.movie.getCredits({ pathParameters: { movie_id: ref } })
  ]))
    .then(([{ data }, { data: credits }]) => ({
      entryType: 'Film',
      originalTitle: data.original_title,
      englishTranslatedTitle: data.title,
      releaseYear: parseInt(data.release_date.substring(0, 4)),
      duration: data.runtime || undefined,
      imageUrl: data.poster_path ? 'https://www.themoviedb.org/t/p/w300_and_h450_bestv2' + data.poster_path : undefined,
      genres: data.genres.map(g => g.name),
      directors: credits.crew.filter((person) => person.job === 'Director').map(p => p.name),
      actors: [...credits.cast]
        // @ts-ignore (library typing is wrong)
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 10)
        // @ts-ignore (library typing is wrong)
        .filter((person) => person.popularity > 6)
        .map((person) => person.name),
      apiRefs: [`tmdb__${ref}`],
      externalUrls: [{ name: 'tmdb', url: `https://www.themoviedb.org/movie/${ref}` }],
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
