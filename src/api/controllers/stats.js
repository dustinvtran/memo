/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const { okAsync, ResultAsync } = require('neverthrow')
const { getSegment } = require('./utils')
const { toPromise } = require('../utils/general')
const db = require('../utils/db/')
const { toScoreTally, toStats } = require('../utils/score_tallies')

/**
 * GET /api/stats/:username
 *
 * Both paths answer with `{ scores, updatedDate }` — `toStats` builds it, and
 * this one names the two fields rather than handing back the stored document
 * as it found it. See #145 and score_tallies.js.
 *
 * A name nobody has taken is a 404, unlike `/api/user/:username` and
 * `/api/name/:username`, which answer 200 with an empty body. Those two are
 * existence probes the frontend calls *expecting* a miss — the list page asks
 * whether a name is free, and the profile page turns an empty answer into its
 * own 404. This route is neither: the profile page only asks for stats once
 * `/api/user` has told it the user exists, so a miss here is a URL naming
 * something that isn't there. It used to be a 502. See #139.
 * @type {(event: Event) => Promise<Response>}
 */
const getUserStats = (event) => toPromise(
  db.findOneByFieldOrFail_('users', 'username', getSegment(0, event))
    .andThen(user => {
      // The stored tallies stand for 48 hours; past that they are recomputed.
      const stats = user?.stats
      const lastUpdated = stats?.updatedDate
      if (!lastUpdated || isMoreThan48HoursAgo(lastUpdated)) {
        return refreshStats(user)
      } else {
        return okAsync(responses.ok(toStats(stats.scores, lastUpdated)))
      }
    }
  )
  .mapErr(responses.fromError)
)

module.exports = {
  getUserStats,
}

/** @type {ValidCollection[]} */
const entryCollections = ['gameEntries', 'tvShowEntries', 'filmEntries', 'bookEntries']

/**
 * Recomputes the histograms and stores them before answering.
 *
 * This writes on a `GET`, which is deliberate: the stats are a cache, and the
 * request that finds them stale is the one that refills it. Two people opening
 * a cold profile at the same moment therefore both count and both write, and
 * that is fine — they compute the same forty-four numbers from the same
 * entries, so whichever `updateByRef_` lands second writes what the first one
 * wrote. It is worth knowing before anyone treats the double write as a bug.
 *
 * The counting itself is four `$group`s — see `toScoreTallyPipeline` in
 * ../utils/db/queries.js. This used to download every non-Planned entry the
 * user had, four lists of them, to read one field off each.
 *
 * @type {(userDocument: any) => ResultAsync<Response, Error>}
 */
const refreshStats = (userDocument) =>
  ResultAsync.combine(
    entryCollections.map((collection) =>
      db
        .countScoresByValue_(collection, userDocument.userId)
        // A `$group` returns a row only for a score somebody used, and the
        // stored shape needs all eleven buckets or `users` fails validation.
        .map(toScoreTally)
    )
  )
    .map(([games, tv, films, books]) => ({ games, tv, films, books }))
    .map((scores) => toStats(scores, Date.now()))
    // The stats that are answered with are the stats that were stored, down to
    // the one object: the response used to omit `updatedDate` entirely, and
    // computing it a second time for the caller would have dated the numbers
    // to a moment other than the one recorded beside them.
    .andThen((stats) =>
      db.updateByRef_('users', userDocument._id, { stats })
        .map(() => responses.ok(stats))
    )

const MS_IN_DAY = 86400000

/** @type {(timestamp: number) => boolean} */
const isMoreThan48HoursAgo = (timestamp) =>
  Date.now() - timestamp > (2*MS_IN_DAY)
