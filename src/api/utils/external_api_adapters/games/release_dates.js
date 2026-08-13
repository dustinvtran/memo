/**
 * @file Reading a release date out of an IGDB game.
 *
 * Pure and dependency-free for the same reason ./time_to_beat.js is: igdb.js
 * cannot be required at all without Twitch credentials, so nothing in it is
 * reachable from the test suite. That is how an unguarded `[0]` on this
 * particular expression stayed in `retrieve` long enough to 500 on every
 * undated game. See ./release_dates.test.js.
 */

/**
 * The earliest date IGDB lists for a game, in seconds, or undefined when it
 * lists none usable.
 *
 * Both the key and the first element need guarding: IGDB omits
 * `release_dates` for an unannounced game, and sends it as an empty array for
 * some others. Dates themselves are dropped when they aren't numbers, so an
 * entry IGDB has a status but no date for can't sort its way to the front and
 * come back as undefined.
 *
 * What gets sorted is the mapped-out list of dates rather than IGDB's own
 * array, which matters because `sort` reorders in place: the previous version
 * of this handed the response back to its caller in a different order than it
 * arrived in.
 *
 * @type {(releaseDates: any) => number | undefined}
 */
const earliestReleaseDate = (releaseDates) =>
  (Array.isArray(releaseDates) ? releaseDates : [])
    .map((releaseDate) => releaseDate?.date)
    .filter((date) => typeof date === 'number' && Number.isFinite(date))
    .sort((a, b) => a - b)[0]

module.exports = {
  earliestReleaseDate,
}
