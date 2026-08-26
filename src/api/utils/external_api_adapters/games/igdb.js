/**
 * @file The games adapter. A lot of this code is duplicated
 * with the Film adapter...
 *
 * Metadata and playtime both come from IGDB. Playtime used to come from the
 * `howlongtobeat` npm package; HowLongToBeat's API is now behind
 * authentication and every route into it is gone. See docs/API_choices.md.
 * Games added while that package was quietly failing have no playtime, which
 * src/db_maintenance/scripts/backfill_game_playtimes.js exists to fill in.
 */
/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').GameRetrieveFunction} GameRetrieveFunction */
/** @typedef {import('../../errors').Error} Error */
/** @typedef {import('../../parsers/games').Game} Game */
import { ResultAsync } from 'neverthrow'
import * as errors from '../../errors.js'
import igdbModule from 'igdb-api-node'
import axios from 'axios'
import { TIME_TO_BEATS_URL, timeToBeatQuery, toPlaytime } from './time_to_beat.js'
import { earliestReleaseDate } from './release_dates.js'
import { involvedCompanyIds, companyIdsToLookUp, companyQueryLimit, companyNames } from './companies.js'
import { throwIt } from '../../general.js'
import { callableDefault } from '../../interop.js'
import { retrying, describeFailure, publicFailure, statusOf } from '../retry.js'
const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env

/**
 * `igdb-api-node` is Babel-compiled CommonJS, so what a default import of it
 * gives depends on who reads `__esModule` — see ../../interop.js. It is the
 * only dependency here that is not the same either way.
 */
const igdb = callableDefault(igdbModule)

/**
 * Checked when a request needs the credentials rather than while this module
 * is read.
 *
 * It used to run at require time, and the comment here said why that was
 * bad — it killed the cold start before any handler existed to report it.
 * It was also what stopped the suite loading the adapters without
 * credentials, so `works.test.js` intercepted the whole index through
 * `Module._load` instead. Both problems are the same problem. The Error is
 * still a real one rather than the bare string this once threw, so there is
 * a stack saying where it came from.
 */
const requireCredentials = () => {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throwIt(new Error(
      'Must set TWITCH_CLIENT_SECRET and TWITCH_CLIENT_ID environment variables.'
    ))
  }
}

/**
 * The token used to live in a module-level promise, which meant one bad
 * minute at Twitch poisoned every request the warm function served afterwards
 * — a rejected promise stays rejected. It is fetched on demand now, kept only
 * once it has worked, and forgotten again if it hasn't.
 * @type {Promise<string> | undefined}
 */
let pendingToken

/** @type {() => Promise<string>} */
const twitchToken = () => {
  pendingToken ??= retrying(() => axios({
    method: 'post',
    url: `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
  })).then(({ data }) => data.access_token)

  return pendingToken.catch((err) => {
    pendingToken = undefined
    throw err
  })
}

/** @type {() => Promise<any>} */
const igdbClient = async () => {
  requireCredentials()
  return igdb(TWITCH_CLIENT_ID, await twitchToken())
}

/** @type SearchFunction */
const search = (titleSearch) => ResultAsync.fromPromise(
  retrying(async () => {
    const client = await igdbClient()

    const req = await client
      .fields(['name', 'cover.url', 'release_dates.*', 'platforms.abbreviation'])
      .limit(50)
      .search(titleSearch)
      .request('/games')

    return req.data.map(({ name, id, release_dates, cover, platforms }) => {
      const earliest_date = earliestReleaseDate(release_dates) * 1000
      return {
        title: name + ` [${platforms?.map((p) => p.abbreviation ?? '?')?.join(', ') ?? '?'}]`,
        ref: id,
        year: earliest_date ? (new Date(earliest_date)).toISOString().substring(0, 4) : undefined,
        imageUrl: cover?.url ? 'https:' + cover.url : undefined,
      }
    })
  }),
  toError('searching for games')
)

/** @type GameRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  retrying(async () => {
    const client = await igdbClient()
    const mainData = await client
      .fields(['name', 'alternative_names.*', 'cover.url', 'release_dates.*', 'genres.name', 'platforms.abbreviation', 'involved_companies.*', 'url'])
      .where(`id = ${ref}`)
      .request('/games')
      .then(({ data }) => data[0])

    // `where(id = ...)` on an id IGDB doesn't hold is an empty array, not an
    // error, and every read below would be a TypeError on undefined. Thrown
    // from inside `retrying` on purpose: a 404 isn't transient, so it comes
    // straight back out rather than costing two more attempts.
    if (!mainData) throwNoSuchGame(ref)

    // `involved_companies` carries ids and role flags; the names are a second
    // request. Everything either side of it is in ./companies.js, where the
    // suite can reach it — #214 was a hole in these two lists, and nothing
    // short of Twitch credentials could have caught it here.
    const publisherIds = involvedCompanyIds(mainData.involved_companies, 'publisher')
    const studioIds = involvedCompanyIds(mainData.involved_companies, 'developer')
    const idsToLookUp = companyIdsToLookUp(studioIds, publisherIds)

    // Neither lookup takes anything but `mainData`, so they go out together
    // and the retrieve costs two round trips rather than three — the same
    // reason tmdb_adapter.js asks for the details and the credits as a pair.
    // This is the wait a user sits through after picking a search result.
    //
    // The two are still allowed to fail differently, which is the part worth
    // being careful with: `Promise.all` rejects the moment either half does,
    // and only the companies half should be able to fail the retrieve.
    // `retrieveTimeToBeat` catches its own failure and resolves to undefined,
    // and that catch is load-bearing here rather than merely tidy — it is
    // what keeps a game worth caching without its playtime.
    const [timeToBeat, companies] = await Promise.all([
      retrieveTimeToBeat(mainData.id),
      idsToLookUp.length > 0
        ? client
            .fields(['name'])
            .where(`id = (${idsToLookUp.join(', ')})`)
            .limit(companyQueryLimit(idsToLookUp))
            .request('/companies')
            .then((resp) => resp.data)
        : [],
    ])

    const playtime = toPlaytime(timeToBeat)

    const publisherNames = companyNames(publisherIds, companies)

    const studioNames = companyNames(studioIds, companies)

    const releaseYearTs = earliestReleaseDate(mainData.release_dates)

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
      imageUrl: mainData.cover?.url ? 'https:' + mainData.cover.url : '',
      genres: mainData.genres?.map((g) => g.name) ?? [],
      platforms: mainData.platforms?.map((p) => p.abbreviation ?? '?') ?? [],
      studios: studioNames,
      publishers: publisherNames,
      apiRefs: [`igdb__${mainData.id}`],
      externalUrls: [
        ...(mainData.url ? [{ name: 'igdb', url: mainData.url }] : []),
      ]
    }
  }),
  toError('retrieving a game')
)

/** @type Adapter */
export {
  search,
  retrieve
}
///////////////////////////////////////////////////////////////////////////////

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
    const data = await retrying(async () => {
      const response = await axios({
        method: 'post',
        url: TIME_TO_BEATS_URL,
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          Authorization: `Bearer ${await twitchToken()}`,
          Accept: 'application/json',
        },
        data: timeToBeatQuery([gameId]),
      })
      return response.data
    })
    return data?.[0]
  } catch (e) {
    console.error(
      `IGDB time to beat lookup failed for game ${gameId}: ${describeFailure(e)}`
    )
    return undefined
  }
}

/**
 * `status` is what carries this back out to `toError`, the same way
 * `throwNoSuchVolume` marks a missing ISBN in books/google.js — `statusOf`
 * reads it, so nothing else needs to know how the two got here.
 * @type {(ref: string | number) => never}
 */
const throwNoSuchGame = (ref) => {
  throw Object.assign(
    new Error(`IGDB holds no game under id ${ref}.`),
    { status: 404 },
  )
}

/**
 * A failure that reaches here has already been retried, so it is worth saying
 * what it actually was. It used to arrive as the string "Something went
 * terribly wrong...", which told nobody anything.
 *
 * Said twice, because the two readers want different things: the whole of it
 * to the log, and to the caller the class of failure alone — enough to know
 * whether trying again is worth it, and no account of our internals. #105.
 *
 * A 404 is the exception: it is an answer rather than a failure — an id
 * IGDB doesn't hold — and telling the user their game doesn't exist beats
 * telling them igdb failed.
 * @type {(doing: string) => (err: any) => Error}
 */
const toError = (doing) => (err) =>
  statusOf(err) === 404
    ? errors.notFound(
        `igdb has no such game (${doing}): ${describeFailure(err)}`,
        'no such game',
      )
    : errors.internal(
        `igdb failed while ${doing}: ${describeFailure(err)}`,
        publicFailure('igdb', err),
      )
