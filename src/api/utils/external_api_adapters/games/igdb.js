/**
 * @file The games adapter. A lot of this code is duplicated
 * with the Film adapter...
 *
 * Metadata and playtime both come from IGDB. Playtime used to come from the
 * `howlongtobeat` npm package; HowLongToBeat's API is now behind
 * authentication and every route into it is gone. See docs/API_choices.md.
 * Games added while that package was quietly failing have no playtime, which
 * src/db_maintenance/backfill_game_playtimes.js exists to fill in.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').GameRetrieveFunction} GameRetrieveFunction */
/** @typedef {import('../../errors').Error} Error */
/** @typedef {import('../../parsers/games').Game} Game */
const { ResultAsync } = require('neverthrow')
const errors = require('../../errors')
const igdb = require('igdb-api-node').default
const axios = require('axios').default
const {
  TIME_TO_BEATS_URL,
  timeToBeatQuery,
  toPlaytime,
} = require('./time_to_beat')

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  throw "Must set TWITCH_CLIENT_SECRET and TWITCH_CLIENT_ID environment variables."
}

const twitchToken =
  axios({
    method: 'post',
    url: `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
  })
    .then(({ data }) => data.access_token)

const igdbClient = twitchToken.then((token) => igdb(TWITCH_CLIENT_ID, token))

/** @type SearchFunction */
const search = (titleSearch) => ResultAsync.fromPromise(
  (async () => {
    try {
      const client = await igdbClient

      const req = await client
        .fields(['name', 'cover.url', 'release_dates.*', 'platforms.abbreviation'])
        .limit(50)
        .search(titleSearch)
        .request('/games')

      const results = req.data.map(({ name, id, release_dates, cover, platforms }) => {
        const earliest_date = release_dates?.sort((a,b) => a.date - b.date)[0]?.date * 1000
        return {
          title: name + ` [${platforms?.map((p) => p.abbreviation ?? '?')?.join(', ') ?? '?'}]`,
          ref: id,
          year: earliest_date ? (new Date(earliest_date)).toISOString().substring(0, 4) : undefined,
          imageUrl: cover?.url ? 'https:' + cover.url : undefined,
        }
      })

      return results
    } catch (e) {
      console.log(e)
      throw "Something went terribly wrong..."
    }
  })(),
  () => errors.internal('Problem searching for games with igdb.')
)

/** @type GameRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  (async () => {
    try {
      const client = await igdbClient
      const mainData = await client
        .fields(['name', 'alternative_names.*', 'cover.url', 'release_dates.*', 'genres.name', 'platforms.abbreviation', 'involved_companies.*', 'url'])
        .where(`id = ${ref}`)
        .request('/games')
        .then(({ data }) => data[0])

      const playtime = toPlaytime(await retrieveTimeToBeat(mainData.id))

      const publisherIds =
        mainData
          .involved_companies
          ?.filter((c) => c.publisher)
          ?.map((c) => c.company)
          ?? []

      const studioIds =
        mainData
          .involved_companies
          ?.filter((c) => c.developer)
          ?.map((c) => c.company)
          ?? []

      const companies = await (
        [studioIds, publisherIds].some((arr) => arr.length > 0)
          ? client
              .fields(['name'])
              .where(
                `id = (${[...studioIds, ...publisherIds].join(', ')})`
              )
              .limit(50)
              .request('/companies')
              .then((resp) => resp.data)
          : []
      )

      const publisherNames =
        publisherIds
          .map((id) => companies.find((c) => c.id === id)?.name)

      const studioNames =
        studioIds
          .map((id) => companies.find((c) => c.id === id)?.name)

      const releaseYearTs =
        mainData.release_dates?.sort((a, b) => a.date - b.date)[0].date

      const releaseYear = releaseYearTs
        ? parseInt(
          (new Date(releaseYearTs * 1000)).toISOString() .substring(0, 4)
        )
          || undefined
        : undefined

      return {
        entryType: 'Game',
        englishTranslatedTitle: mainData.name,
        originalTitle: mainData.alternative_names
          ?.find((n) => n.comment?.includes('riginal'))
          ?.name,
        releaseYear,
        // `duration` and `durationSource` together, or neither of them.
        ...playtime,
        imageUrl: mainData.cover.url ? 'https:' + mainData.cover.url : '',
        genres: mainData.genres?.map((g) => g.name) ?? [],
        platforms: mainData.platforms?.map((p) => p.abbreviation ?? '?') ?? [],
        studios: studioNames,
        publishers: publisherNames,
        apiRefs: [`igdb__${mainData.id}`],
        externalUrls: [
          ...(mainData.url ? [{ name: 'igdb', url: mainData.url }] : []),
        ]
      }
    } catch (e) {
      console.log(e)
      throw "Something went very wrong..."
    }
  })(),
  () => errors.internal('Problem retrieving game with igdb.')
)

/**
 * IGDB holds no time to beat for roughly a third of games. That is ordinary,
 * and comes back as undefined.
 *
 * A failed *request* is not ordinary, so it is logged. The lookup this
 * replaced ended in `.catch(() => undefined)`, which is why the package dying
 * cost every game added since then its playtime without anyone noticing.
 * It still doesn't fail the whole retrieve — a game is worth caching without
 * its playtime, and backfill_game_playtimes.js can fill the gap later — but
 * it no longer fails in silence.
 *
 * @type {(gameId: number | string) => Promise<any | undefined>}
 */
const retrieveTimeToBeat = async (gameId) => {
  try {
    const { data } = await axios({
      method: 'post',
      url: TIME_TO_BEATS_URL,
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${await twitchToken}`,
        Accept: 'application/json',
      },
      data: timeToBeatQuery([gameId]),
    })
    return data?.[0]
  } catch (e) {
    console.error(
      `IGDB time to beat lookup failed for game ${gameId}: ` +
      `${e?.response?.status ?? ''} ${e?.response?.data ?? e?.message ?? e}`
    )
    return undefined
  }
}

/** @type Adapter */
module.exports = {
  search,
  retrieve
}
