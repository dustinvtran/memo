const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  SEARCH_IMAGE_URL_PREFIX,
  POSTER_IMAGE_URL_PREFIX,
  MAX_ACTORS,
  FILM_MAPPING,
  TV_SHOW_MAPPING,
  releaseYearString,
  releaseYear,
  genreNames,
  directorNames,
  notableActors,
  episodeCount,
  toSearchResults,
  toWork,
} = require('./tmdb_mapping')

/** A `/movie/{id}` response, cut down to the fields that are read. */
const aFilm = {
  title: 'Spirited Away',
  original_title: '千と千尋の神隠し',
  release_date: '2001-07-20',
  runtime: 125,
  poster_path: '/poster.jpg',
  genres: [{ id: 16, name: 'Animation' }, { id: 14, name: 'Fantasy' }],
}

/** A `/tv/{id}` response, likewise. */
const aShow = {
  name: 'Fargo',
  original_name: 'Fargo',
  first_air_date: '2014-04-15',
  episode_run_time: [53, 60],
  poster_path: '/poster.jpg',
  genres: [{ id: 80, name: 'Crime' }],
  seasons: [
    { season_number: 0, episode_count: 4, name: 'Specials' },
    { season_number: 1, episode_count: 10 },
    { season_number: 2, episode_count: 10 },
  ],
}

const credits = {
  crew: [
    { job: 'Director', name: 'Hayao Miyazaki' },
    { job: 'Series Director', name: 'Adam Bernstein' },
    { job: 'Producer', name: 'Toshio Suzuki' },
  ],
  cast: [
    { name: 'Billed First', popularity: 4 },
    { name: 'Billed Second', popularity: 30 },
    { name: 'Billed Third', popularity: 12 },
  ],
}

///////////////////////////////////////////////////////////////////////////////
// The year, which is the bug this file exists for.

test('a year comes out of a date', () => {
  assert.equal(releaseYear('2001-07-20'), 2001)
  assert.equal(releaseYearString('2001-07-20'), '2001')
})

test('a film with no release date has no year rather than a NaN', () => {
  // TMDB sends `""` for an unreleased film. `parseInt("")` is `NaN`, which
  // `releaseYear: z.number()...` rejects — the failure this refactor is for.
  assert.equal(releaseYear(''), undefined)
  assert.equal(releaseYear(null), undefined)
  assert.equal(releaseYear(undefined), undefined)
  assert.equal(releaseYear('not a date'), undefined)

  assert.equal(releaseYearString(''), undefined)
  assert.equal(releaseYearString(null), undefined)
  assert.equal(releaseYearString(undefined), undefined)
})

test('an unreleased film maps without throwing and without a year', () => {
  // The unguarded `data.release_date.substring(0, 4)` was a TypeError, and
  // a 500 rather than a work with one field missing.
  const work = toWork(FILM_MAPPING, '129', { ...aFilm, release_date: null }, credits)

  assert.equal(work.releaseYear, undefined)
  assert.equal(work.englishTranslatedTitle, 'Spirited Away')
})

///////////////////////////////////////////////////////////////////////////////
// The two behaviours #112 decided on.

test('specials do not count towards a show\'s episodes', () => {
  // TMDB files specials as season 0. Counting them reported 24 episodes for a
  // show with 20, and the progress column read `10/24`.
  assert.equal(episodeCount(aShow.seasons), 20)
})

test('a show TMDB lists no seasons for has no episode count', () => {
  // Not 0: `${seen}/0` reads as a real count where `${seen}/-` reads as
  // unknown, the same reason a `duration` of 0 is not a duration.
  assert.equal(episodeCount([]), undefined)
  assert.equal(episodeCount([{ season_number: 0, episode_count: 3 }]), undefined)
  assert.equal(episodeCount(undefined), undefined)
  assert.equal(episodeCount({}), undefined)
})

test('a season without a usable count is skipped, not added as NaN', () => {
  assert.equal(episodeCount([
    { season_number: 1, episode_count: 10 },
    { season_number: 2 },
    { season_number: 3, episode_count: null },
  ]), 10)
})

test('the notable actors are filtered before they are cut to ten', () => {
  // Slicing first dropped an eleventh-billed actor who cleared the bar.
  const cast = [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `Unpopular ${i}`, popularity: 1 })),
    { name: 'Popular But Eleventh', popularity: 40 },
  ]

  assert.deepEqual(notableActors(cast), ['Popular But Eleventh'])
})

test('at most ten actors survive, most popular first', () => {
  const cast = Array.from({ length: 15 }, (_, i) => ({
    name: `Actor ${i}`,
    popularity: 10 + i,
  }))
  const actors = notableActors(cast)

  assert.equal(actors.length, MAX_ACTORS)
  assert.equal(actors[0], 'Actor 14')
  assert.equal(actors.at(-1), 'Actor 5')
})

test('a cast where only some clear the bar keeps only those', () => {
  assert.deepEqual(notableActors(credits.cast), ['Billed Second', 'Billed Third'])
})

test('the popularity bar is exclusive and non-numbers do not clear it', () => {
  assert.deepEqual(notableActors([{ name: 'Exactly Six', popularity: 6 }]), [])
  assert.deepEqual(notableActors([{ name: 'No Number', popularity: 'lots' }]), [])
  assert.deepEqual(notableActors([{ name: 'None At All' }]), [])
  assert.deepEqual(notableActors(undefined), [])
})

test('the cast TMDB sent is left in the order it arrived in', () => {
  // `sort` reorders in place; the sort here runs on the array `filter` built.
  const cast = [
    { name: 'First', popularity: 10 },
    { name: 'Second', popularity: 30 },
  ]
  notableActors(cast)

  assert.deepEqual(cast.map((person) => person.name), ['First', 'Second'])
})

///////////////////////////////////////////////////////////////////////////////
// The rest of the shared mapping.

test('a missing genres or crew is an empty list, not a throw', () => {
  assert.deepEqual(genreNames(undefined), [])
  assert.deepEqual(genreNames([{ id: 1 }]), [])
  assert.deepEqual(directorNames(undefined, ['Director']), [])
})

test('a show counts its series directors and a film does not', () => {
  assert.deepEqual(directorNames(credits.crew, FILM_MAPPING.directorJobs), [
    'Hayao Miyazaki',
  ])
  assert.deepEqual(directorNames(credits.crew, TV_SHOW_MAPPING.directorJobs), [
    'Hayao Miyazaki',
    'Adam Bernstein',
  ])
})

test('a film maps to a film work', () => {
  const work = toWork(FILM_MAPPING, '129', aFilm, credits)

  assert.deepEqual(work, {
    entryType: 'Film',
    originalTitle: '千と千尋の神隠し',
    englishTranslatedTitle: 'Spirited Away',
    releaseYear: 2001,
    duration: 125,
    imageUrl: POSTER_IMAGE_URL_PREFIX + '/poster.jpg',
    genres: ['Animation', 'Fantasy'],
    directors: ['Hayao Miyazaki'],
    actors: ['Billed Second', 'Billed Third'],
    apiRefs: ['tmdb__129'],
    externalUrls: [{ name: 'tmdb', url: 'https://www.themoviedb.org/movie/129' }],
  })
})

test('a show maps to a tv show work, episodes and all', () => {
  const work = toWork(TV_SHOW_MAPPING, '60622', aShow, credits)

  assert.deepEqual(work, {
    entryType: 'TVShow',
    originalTitle: 'Fargo',
    englishTranslatedTitle: 'Fargo',
    releaseYear: 2014,
    // One episode's runtime, the first TMDB lists — not the whole show's.
    duration: 53,
    imageUrl: POSTER_IMAGE_URL_PREFIX + '/poster.jpg',
    genres: ['Crime'],
    directors: ['Hayao Miyazaki', 'Adam Bernstein'],
    actors: ['Billed Second', 'Billed Third'],
    apiRefs: ['tmdb__60622'],
    externalUrls: [{ name: 'tmdb', url: 'https://www.themoviedb.org/tv/60622' }],
    episodes: 20,
  })
})

test('a film work carries no episodes key at all', () => {
  assert.equal('episodes' in toWork(FILM_MAPPING, '129', aFilm, credits), false)
})

test('a zero runtime is no duration rather than a duration of zero', () => {
  assert.equal(FILM_MAPPING.duration({ runtime: 0 }), undefined)
  assert.equal(FILM_MAPPING.duration({}), undefined)
  assert.equal(TV_SHOW_MAPPING.duration({ episode_run_time: [] }), undefined)
  assert.equal(TV_SHOW_MAPPING.duration({}), undefined)
})

test('a work with no poster has no image url', () => {
  const work = toWork(FILM_MAPPING, '129', { ...aFilm, poster_path: null }, credits)

  assert.equal(work.imageUrl, undefined)
})

///////////////////////////////////////////////////////////////////////////////
// Search.

test('a film search result reads its own field names', () => {
  const results = toSearchResults(FILM_MAPPING, {
    results: [{ id: 129, title: 'Spirited Away', release_date: '2001-07-20', poster_path: '/p.jpg' }],
  })

  assert.deepEqual(results, [{
    title: 'Spirited Away',
    year: '2001',
    ref: '129',
    imageUrl: SEARCH_IMAGE_URL_PREFIX + '/p.jpg',
  }])
})

test('a tv search result reads its own field names', () => {
  const results = toSearchResults(TV_SHOW_MAPPING, {
    results: [{ id: 60622, name: 'Fargo', first_air_date: '2014-04-15', poster_path: null }],
  })

  assert.deepEqual(results, [{
    title: 'Fargo',
    year: '2014',
    ref: '60622',
    imageUrl: undefined,
  }])
})

test('a search result with no date carries no year', () => {
  const [result] = toSearchResults(FILM_MAPPING, {
    results: [{ id: 1, title: 'Unannounced', release_date: '' }],
  })

  assert.equal(result.year, undefined)
})

test('a search that matched nothing is an empty list', () => {
  assert.deepEqual(toSearchResults(FILM_MAPPING, { results: [] }), [])
  assert.deepEqual(toSearchResults(FILM_MAPPING, {}), [])
  assert.deepEqual(toSearchResults(FILM_MAPPING, undefined), [])
})
