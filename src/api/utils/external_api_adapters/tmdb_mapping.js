/**
 * @file Turning a TMDB response into a stored work.
 *
 * Pure and dependency-free for the same reason ./games/release_dates.js is:
 * ./tmdb_adapter.js constructs a node-themoviedb client at require time and
 * throws without TMDB_API_KEY, so nothing behind it is reachable from the test
 * suite. Everything that decides what gets written lives here instead — the
 * two mappings included — and is unit tested against the response shapes TMDB
 * really sends (./tmdb_mapping.test.js).
 *
 * films/tmdb.js and tv_shows/tmdb.js differ in the two mappings below and in
 * the three client calls each hands ./tmdb_adapter.js. Everything else was
 * duplicated between them until #112, which is how the film half went without
 * the `release_date` guard the tv half had.
 */

/** The poster sizes: the small one for a search row, the large one for a work. */
const SEARCH_IMAGE_URL_PREFIX = 'https://www.themoviedb.org/t/p/w116_and_h174_face'
const POSTER_IMAGE_URL_PREFIX = 'https://www.themoviedb.org/t/p/w300_and_h450_bestv2'

/** "The top ten notable actors": at most this many, none less popular than this. */
const MAX_ACTORS = 10
const MIN_ACTOR_POPULARITY = 6

/** @type {(posterPath: any, prefix: string) => string | undefined} */
const posterUrl = (posterPath, prefix) =>
  typeof posterPath === 'string' && posterPath ? prefix + posterPath : undefined

/**
 * The four-digit year out of a TMDB date, as it goes into a search result.
 *
 * TMDB sends `""` for a film with no announced release date, `null` for some
 * others, and omits the key outright for the rest, so this cannot be a bare
 * `.substring(0, 4)`. See ./tmdb_mapping.test.js.
 * @type {(date: any) => string | undefined}
 */
const releaseYearString = (date) =>
  (typeof date === 'string' ? date.substring(0, 4) : '') || undefined

/**
 * The same year as a number, or undefined when TMDB has no usable date.
 *
 * Undefined rather than `NaN`: `releaseYear` is `z.number().nullable().or(
 * z.undefined())`, so a `NaN` fails the parse instead of reading as "we don't
 * know", which is what an unreleased film means. The film adapter read
 * `data.release_date.substring(0, 4)` unguarded for as long as it was a copy
 * of the tv one — a `""` was a zod failure and a `null` a 500.
 * @type {(date: any) => number | undefined}
 */
const releaseYear = (date) => {
  const year = parseInt(releaseYearString(date) ?? '')
  return Number.isFinite(year) ? year : undefined
}

/** @type {(genres: any) => string[]} */
const genreNames = (genres) =>
  (Array.isArray(genres) ? genres : [])
    .map((genre) => genre?.name)
    .filter((name) => typeof name === 'string')

/**
 * The names of everyone in the crew doing one of `jobs`. TMDB files a show's
 * own director under `Series Director` and an episode's under `Director`,
 * where a film only ever has the latter.
 * @type {(crew: any, jobs: string[]) => string[]}
 */
const directorNames = (crew, jobs) =>
  (Array.isArray(crew) ? crew : [])
    .filter((person) => jobs.includes(person?.job))
    .map((person) => person.name)
    .filter((name) => typeof name === 'string')

/**
 * The notable actors, most popular first.
 *
 * The filter runs before the slice. Sorting, slicing and then filtering — what
 * this did — drops an eleventh-billed actor who clears the bar, and answers
 * with three names for a cast where only three clear it. Neither is "the top
 * ten notable actors", which is what the two constants read as together.
 *
 * The sort is in place on the array `filter` just built rather than on TMDB's
 * own, which `[...credits.cast]` was there to protect.
 * @type {(cast: any) => string[]}
 */
const notableActors = (cast) =>
  (Array.isArray(cast) ? cast : [])
    .filter((person) => Number(person?.popularity) > MIN_ACTOR_POPULARITY)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, MAX_ACTORS)
    .map((person) => person.name)
    .filter((name) => typeof name === 'string')

/**
 * How many episodes a show has, not counting its specials.
 *
 * TMDB files specials as season 0, so summing every season's `episode_count`
 * reports more episodes than the show has and the list's progress column
 * (`${seen}/${totalEps}`) inherits it. Season 0 is excluded here; #112 has the
 * reasoning, and it changes what gets stored for shows retrieved from now on.
 *
 * Undefined rather than 0 for a show TMDB lists no seasons for, for the reason
 * a `duration` of 0 is not a duration: 0 renders as a real count in the
 * progress column where undefined renders as `-`.
 * @type {(seasons: any) => number | undefined}
 */
const episodeCount = (seasons) => {
  const counts = (Array.isArray(seasons) ? seasons : [])
    .filter((season) => Number(season?.season_number) > 0)
    .map((season) => Number(season?.episode_count))
    .filter((count) => Number.isFinite(count))

  return counts.length ? counts.reduce((eps, count) => eps + count, 0) : undefined
}

/**
 * @typedef {object} Mapping
 * @property {string} entryType
 * @property {string} urlSegment which themoviedb.org path a work sits under
 * @property {string} title
 * @property {string} originalTitle
 * @property {string} releaseDate
 * @property {string[]} directorJobs
 * @property {string} notFoundMessage what a 404 tells the caller (#105)
 * @property {(data: any) => number | undefined} duration
 * @property {(data: any) => object} [extraFields] anything only one type has
 */

/** @type Mapping */
const FILM_MAPPING = {
  entryType: 'Film',
  urlSegment: 'movie',
  title: 'title',
  originalTitle: 'original_title',
  releaseDate: 'release_date',
  directorJobs: ['Director'],
  notFoundMessage: 'no such film',
  duration: (data) => data?.runtime || undefined,
}

/** @type Mapping */
const TV_SHOW_MAPPING = {
  entryType: 'TVShow',
  urlSegment: 'tv',
  title: 'name',
  originalTitle: 'original_name',
  releaseDate: 'first_air_date',
  directorJobs: ['Director', 'Series Director'],
  notFoundMessage: 'no such tv show',
  // A show's `duration` is one episode's; TMDB lists the runtimes it has seen.
  duration: (data) => data?.episode_run_time?.[0] || undefined,
  extraFields: (data) => ({ episodes: episodeCount(data?.seasons) }),
}

/** @type {(mapping: Mapping, data: any) => object[]} */
const toSearchResults = (mapping, data) =>
  (Array.isArray(data?.results) ? data.results : []).map((result) => ({
    title: result[mapping.title],
    year: releaseYearString(result[mapping.releaseDate]),
    ref: String(result.id),
    imageUrl: posterUrl(result.poster_path, SEARCH_IMAGE_URL_PREFIX),
  }))

/**
 * A work document, from TMDB's details and credits responses for one id.
 * @type {(mapping: Mapping, ref: string, data: any, credits: any) => object}
 */
const toWork = (mapping, ref, data, credits) => ({
  entryType: mapping.entryType,
  originalTitle: data?.[mapping.originalTitle],
  englishTranslatedTitle: data?.[mapping.title],
  releaseYear: releaseYear(data?.[mapping.releaseDate]),
  duration: mapping.duration(data),
  imageUrl: posterUrl(data?.poster_path, POSTER_IMAGE_URL_PREFIX),
  genres: genreNames(data?.genres),
  directors: directorNames(credits?.crew, mapping.directorJobs),
  actors: notableActors(credits?.cast),
  apiRefs: [`tmdb__${ref}`],
  externalUrls: [{
    name: 'tmdb',
    url: `https://www.themoviedb.org/${mapping.urlSegment}/${ref}`,
  }],
  ...mapping.extraFields?.(data),
})

module.exports = {
  SEARCH_IMAGE_URL_PREFIX,
  POSTER_IMAGE_URL_PREFIX,
  MAX_ACTORS,
  MIN_ACTOR_POPULARITY,
  FILM_MAPPING,
  TV_SHOW_MAPPING,
  posterUrl,
  releaseYearString,
  releaseYear,
  genreNames,
  directorNames,
  notableActors,
  episodeCount,
  toSearchResults,
  toWork,
}
