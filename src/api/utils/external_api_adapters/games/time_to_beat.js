/**
 * @file Turning IGDB's `/game_time_to_beats` rows into a stored playtime.
 *
 * Pure and dependency-free on purpose: both the adapter (one game at a time)
 * and src/db_maintenance/scripts/backfill_game_playtimes.js (every game at
 * once) map playtimes through here, and the mapping is unit tested
 * (./time_to_beat.test.js) without needing credentials or a network.
 *
 * The endpoint is plural. `/game_time_to_beat` and `/time_to_beat` both 404,
 * which makes it easy to conclude it doesn't exist.
 *
 *   POST https://api.igdb.com/v4/game_time_to_beats
 *   Client-ID: <twitch client id>, Authorization: Bearer <twitch app token>
 *   fields game_id,hastily,normally,completely,count; where game_id = (3042);
 *
 *   { "game_id": 3042, "hastily": 45000, "normally": 102780,
 *     "completely": 165270, "count": 13 }
 *
 * `hastily` / `normally` / `completely` are HowLongToBeat's Main /
 * Main+Extra / Completionist, in *seconds*. `duration` is in minutes.
 */

const TIME_TO_BEATS_URL = 'https://api.igdb.com/v4/game_time_to_beats'

/** IGDB will not return more than 500 rows for one query. */
const MAX_GAME_IDS_PER_QUERY = 500

/**
 * Which of the three times becomes `duration`: how long the game takes a
 * player who is neither rushing it nor completing it.
 *
 * Not `hastily`, despite that being the closer match to the playtimes already
 * stored, because `hastily` is a rushed time rather than a Main Story one —
 * IGDB puts Hollow Knight at 16.7h against HowLongToBeat's ~25h, and Astro
 * Bot at 2.0h against ~11h. `normally` also reaches 72 of the games that need
 * a playtime where `hastily` reaches 61.
 *
 * It does read longer than what is already there: the stored playtimes came
 * from HowLongToBeat's `gameplayMain`, and `normally` runs about 1.36x them
 * (median 19.3h against their 11.0h). That is exactly why `durationSource`
 * exists and why this only ever fills gaps — the column holds two different
 * measurements now, and which is which is recorded rather than guessed at.
 */
const TIME_TO_BEAT_FIELD = 'normally'

/** The value `durationSource` carries for a playtime that came from here. */
const DURATION_SOURCE = 'igdb'

/** @type {(gameIds: (number | string)[]) => string} */
const timeToBeatQuery = (gameIds) =>
  `fields game_id,hastily,normally,completely,count; ` +
  `where game_id = (${gameIds.join(',')}); ` +
  `limit ${MAX_GAME_IDS_PER_QUERY};`

/** Splits ids into query-sized batches, so 1,100 games cost 3 requests. */
/** @type {<T>(gameIds: T[]) => T[][]} */
const batchGameIds = (gameIds) => {
  const batches = []
  for (let at = 0; at < gameIds.length; at += MAX_GAME_IDS_PER_QUERY) {
    batches.push(gameIds.slice(at, at + MAX_GAME_IDS_PER_QUERY))
  }
  return batches
}

/**
 * Seconds to whole minutes. Returns undefined for anything that isn't a real
 * measurement, so "IGDB has no time for this game" and "IGDB returned junk"
 * both come out as "no playtime" rather than as a `duration` of 0.
 * @type {(timeToBeat: any) => number | undefined}
 */
const toDurationInMinutes = (timeToBeat) => {
  const seconds = timeToBeat?.[TIME_TO_BEAT_FIELD]
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined
  }
  // Round up rather than to zero: a game that takes a few seconds to beat is
  // a real (if silly) thing, and 0 would read as "unknown" everywhere else.
  return Math.max(1, Math.round(seconds / 60))
}

/**
 * The fields to store for a game, or undefined when there is no playtime to
 * store. `duration` and `durationSource` are always written together — a
 * `durationSource` on a duration that came from somewhere else would be a
 * lie, and the point of recording provenance is that it can be trusted.
 * @type {(timeToBeat: any) => { duration: number, durationSource: string } | undefined}
 */
const toPlaytime = (timeToBeat) => {
  const duration = toDurationInMinutes(timeToBeat)
  return duration === undefined
    ? undefined
    : { duration, durationSource: DURATION_SOURCE }
}

/**
 * Rows keyed by the game id they describe, as numbers — IGDB answers with
 * numeric `game_id`s while our apiRefs are strings.
 * @type {(rows: any) => Map<number, any>}
 */
const indexTimesByGameId = (rows) =>
  new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => Number.isFinite(Number(row?.game_id)))
      .map((row) => [Number(row.game_id), row])
  )

module.exports = {
  TIME_TO_BEATS_URL,
  MAX_GAME_IDS_PER_QUERY,
  TIME_TO_BEAT_FIELD,
  DURATION_SOURCE,
  timeToBeatQuery,
  batchGameIds,
  toDurationInMinutes,
  toPlaytime,
  indexTimesByGameId,
}
