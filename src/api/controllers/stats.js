/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const { combine, okAsync, ResultAsync } = require('neverthrow')
const { getSegment } = require('./utils')
const { toPromise } = require('../utils/general')
const db = require('../utils/db/')

const CACHE_STATS = true

/** @type {(event: Event) => Promise<Response>} */
const getUserStats = (event) => toPromise(
  db.findOneByField_('users', 'username', getSegment(0, event))
    .andThen(result => {
      // We can cache stats if we want by uncommenting this
      const stats = result?.data?.stats
      const lastUpdated = stats?.updatedDate
      if (!CACHE_STATS || !lastUpdated || isMoreThan48HoursAgo(lastUpdated)) {
        return refreshStats(result)
      } else {
        return okAsync(responses.ok(stats))
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
 * Which entries count is the filter's business, so a score is the whole of
 * what a tally reads off one. Everything else on the document — the dates,
 * the overrides, the workRef — was four lists fetched in full to arrive at
 * forty numbers.
 */
const TALLY_FIELDS = { score: 1 }

/** @type {(userDocument: any) => ResultAsync<Response, Error>} */
const refreshStats = (userDocument) => {
  /** @type {ResultAsync<[ValidCollection, any][], Error>} */
  const entries = combine(
    entryCollections
      .flatMap((col) =>
        db.findMany_(
          col,
          // Planned entries are the ones with nothing to score yet, and
          // `$ne` matches an entry with no status at all, as the filter it
          // replaces did.
          { userId: userDocument.data.userId, status: { $ne: 'Planned' } },
          { projection: TALLY_FIELDS }
        )
          .map((data) => data.map((doc) => [col, doc]))
      )
  )

  const allTallies =
    combine(
      entryCollections.map((collection) =>
        entries
          .map((allEntries) =>
            allEntries
              .flat()
              .filter(([col]) => col === collection)
              .map(([_, data]) => data)
          )
          .map(toTallies)
      )
    )
      .map(([games, tv, films, books]) => ({ games, tv, films, books }))

  return allTallies.andThen((scores) =>
    db.updateByRef_('users', userDocument.ref.id, { stats: {
      scores,
      updatedDate: Date.now(),
    }})
      .map(() => responses.ok({ scores }))
  )
}

const toTallies = (/** @type {any[]} */ entries) => ({
  [1]: getTallyOfScore(1, entries),
  [2]: getTallyOfScore(2, entries),
  [3]: getTallyOfScore(3, entries),
  [4]: getTallyOfScore(4, entries),
  [5]: getTallyOfScore(5, entries),
  [6]: getTallyOfScore(6, entries),
  [7]: getTallyOfScore(7, entries),
  [8]: getTallyOfScore(8, entries),
  [9]: getTallyOfScore(9, entries),
  [10]: getTallyOfScore(10, entries),
  unrated: getTallyOfScore(undefined, entries),
})

/** @type {(score: number | undefined, entries: any[]) => number} */
const getTallyOfScore = (score, entries) =>
  entries.filter((e) => e.data.score == score).length

const MS_IN_DAY = 86400000

/** @type {(timestamp: number) => boolean} */
const isMoreThan48HoursAgo = (timestamp) =>
  Date.now() - timestamp > (2*MS_IN_DAY)
