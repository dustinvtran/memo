/**
 * @file The queries this module sends, without the database.
 *
 * `db.js` builds a MongoClient at require time and throws without
 * `MONGODB_URL`, so nothing in unsafe_functions.js can be reached from
 * `node --test`. What a query *asks for* is worth testing even so — a `$limit`
 * on the wrong side of a `$lookup` still returns the right rows, it just joins
 * four hundred documents to return five — so the describing lives here, pure
 * and dependency-free, and the queries call it. See queries.test.js, and
 * shapes.js for the other half of the same split.
 */

/**
 * A whole list in one query: the user's entries, newest first, joined to the
 * works they point at.
 *
 * The order and the limit are stages rather than something the caller does to
 * the results, and they come *before* the `$lookup` so that a limited request
 * joins the metadata onto the entries it is going to return instead of onto
 * all of them. The profile page asks for five rows of each list; sorted and
 * sliced afterwards, that was four full lists joined and sent to render twenty
 * rows.
 *
 * A missing `updatedDate` sorts last. `_id` only breaks ties, of which there
 * are a great many — a bulk import stamps a whole list with one millisecond —
 * and it breaks them the same way every time, which sorting in Node did not:
 * that left entries stamped the same millisecond in whatever order the
 * database happened to return them, so a limit would have taken a different
 * five on every request.
 *
 * @type {(args: { userId: string, workCollection: string, limit?: number }) => object[]}
 */
const toUserEntriesPipeline = ({ userId, workCollection, limit }) => [
  { $match: { userId } },
  { $sort: { updatedDate: -1, _id: 1 } },
  ...(limit ? [{ $limit: limit }] : []),
  {
    $lookup: {
      from: workCollection,
      localField: 'workRef',
      foreignField: '_id',
      as: 'work',
    },
  },
  // Nobody reads any of these from a list, and they are not small:
  // `review` is the whole note, which the reviews endpoint serves when a row
  // is actually opened; `userId` is an auth0 id repeated once per entry for
  // anyone who asks for the list; and `commonMetadata` is a stale copy of the
  // work that the `$lookup` above has just fetched the live version of — the
  // caller overwrites it with `work.data` on the way out, so every byte of it
  // crossed the wire to be thrown away. 1.2 MB of that on a four-list profile
  // load. See #176.
  { $project: { review: 0, userId: 0, commonMetadata: 0 } },
]

/**
 * A user's score histogram for one collection, counted by the database.
 *
 * The profile's forty-four numbers used to be four lists downloaded in full so
 * that Node could count them. `$group` returns one row per score that occurs —
 * at most eleven — and with the `userId` index the `$match` never touches a
 * document it does not need.
 *
 * The `$match` is the filter it replaces: `$ne` excludes `Planned`, the status
 * for an entry with nothing to score yet, and matches an entry carrying no
 * status at all, as `doc.data.status !== 'Planned'` did.
 *
 * A score that is missing and one that is explicitly `null` group together
 * under `_id: null`, which is the `unrated` bucket. Turning these rows into
 * the stored shape — every bucket present, including the ones no row came back
 * for — is `toScoreTally` in ../score_tallies.js.
 *
 * @type {(args: { userId: string }) => object[]}
 */
const toScoreTallyPipeline = ({ userId }) => [
  { $match: { userId, status: { $ne: 'Planned' } } },
  { $group: { _id: '$score', count: { $sum: 1 } } },
]

/**
 * The driver options of a `find` or a `findOne`, with the ones nobody asked
 * for left out rather than passed as `undefined`.
 *
 * `session` is how a read joins a transaction — `withTransaction` hands one
 * out, and a read made without it cannot see what that transaction has
 * written so far.
 *
 * @typedef {{ projection?: object, sort?: object, limit?: number, session?: import('mongodb').ClientSession }} QueryOptions
 * @type {(options?: QueryOptions) => QueryOptions}
 */
const toFindOptions = ({ projection, sort, limit, session } = {}) => ({
  ...(projection ? { projection: keepingId(projection) } : {}),
  ...(sort ? { sort } : {}),
  ...(limit ? { limit } : {}),
  ...(session ? { session } : {}),
})

module.exports = {
  toUserEntriesPipeline,
  toScoreTallyPipeline,
  toFindOptions,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * Every document handed out of this module is wrapped by
 * `toSameFormatAsFaunaDb`, which reads `_id` to build the `ref.id` that
 * callers update and delete by. A projection that dropped it would hand back
 * rows nothing can act on, and only as a missing field rather than as an
 * error. An inclusion projection keeps `_id` on its own, so this has only to
 * undo an explicit exclusion.
 */
const keepingId = (projection) =>
  projection._id === 0 || projection._id === false
    ? Object.fromEntries(
        Object.entries(projection).filter(([field]) => field !== '_id')
      )
    : projection
