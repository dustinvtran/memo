/**
 * @file These functions may throw and should be considered
 * private to this module. They must be converted to safe
 * promises or safe ResultAsyncs with toPromise or toResult
 * pefore being re-exported.
 *
 * Every write takes an optional `session` last, and every read takes one in
 * its `QueryOptions`. It is the session `withTransaction` hands out, and it
 * is what puts the query inside that transaction; without it a query runs on
 * its own, which is what everything but the entry-saving path wants.
 */
/** @typedef {import('../parsers').ValidCollection} ValidCollection */
/** @typedef {import('mongodb').ObjectId} ObjectId */
/** @typedef {import('mongodb').ClientSession} ClientSession */
const { mongo } = require('./db')
// The platform generates the v4 string, rather than the `uuid` package: these
// functions are CommonJS and the deployed functions runtime cannot `require` an
// ES module, which is what uuid became at v13 — every route 502'd on load. Node
// has had `randomUUID` since 14.17 and it produces the same kind of _id.
const { randomUUID } = require('node:crypto')
const { throwIt } = require('../general')
const parsers = require('../parsers/')
const { toEntryWithMetadata } = require('./shapes')
const { toUserEntriesPipeline, toScoreTallyPipeline, toFindOptions } = require('./queries')
const workTypes = require('../work_types')

/** @typedef {import('./queries').QueryOptions} QueryOptions */

/**
 * A whole filter document, so a query can name more than one field, and the
 * options to go with it. `findDraft` is the reason: one draft per entry per
 * user is two fields, and asking on one of them meant reading every revision
 * of the entry — up to 50 snapshots, each carrying a full copy of the note —
 * to keep the one document that matched both.
 * @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => Promise<any | null>}
 */
const _findOne = (collection, filter, options) =>
  findFirst(collection, filter, options)

/** @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => Promise<any[]>} */
const _findMany = (collection, filter, options) =>
  find(collection, filter, options)

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<any | null>} */
const _findOneByField = (collection, field, value) =>
  findFirst(collection, { [field]: value })

/** @type {(collection: ValidCollection, ref: string) => Promise<any | null>} */
const _findOneByRef = (collection, ref) =>
  findFirst(collection, { _id: ref })

/**
 * One query for many values of the same field, rather than one query per
 * value. A whole list's reviews are 400-odd `entryRef`s, and 400 round trips
 * is the difference between a response and a function timeout.
 * @type {(collection: ValidCollection, field: string, values: any[], options?: QueryOptions) => Promise<any[]>}
 */
const _findAllByFieldIn = (collection, field, values, options) =>
  values.length === 0
    ? Promise.resolve([])
    : find(collection, { [field]: { $in: values } }, options)

/** @type {(collection: ValidCollection, ref: string, update: any, session?: ClientSession) => Promise<object>} */
const _updateOneByRef = (collection, ref, update, session) =>
  mongo((db) => db
    .collection(collection)
    .updateOne({ _id: ref }, { $set: update }, { session })
  )

/** @type {(collection: ValidCollection, ref: string, session?: ClientSession) => Promise<object>} */
const _deleteOneByRef = (collection, ref, session) =>
  mongo((db) => db
    .collection(collection)
    .deleteOne({ _id: ref }, { session })
  )

/** @type {(collection: ValidCollection, field: string, value: any, session?: ClientSession) => Promise<object>} */
const _deleteAllByField = (collection, field, value, session) =>
  mongo((db) => db
    .collection(collection)
    .deleteMany({ [field]: value }, { session })
  )

/** @type {(collection: ValidCollection, data: any, session?: ClientSession) => Promise<object>} */
const _create = (collection, data, session) =>
  parsers[collection](data).match(
    (validDoc) => unsafeCreateDoc(collection, validDoc, session),
    (err) => throwIt(err)
  )

/**
 * A whole list in one query. The ordering and the limit are the database's
 * job rather than this function's, so a limited request joins the metadata
 * onto the entries it is going to return instead of onto all of them.
 *
 * @type {(collection: 'filmEntries' | 'gameEntries' | 'tvShowEntries' | 'bookEntries', userId: string, limit?: number) => Promise<{ entry: any, work: any }[]>}
 */
const _findAllUserEntriesWithMetadata = (collection, userId, limit) => {
  const { works: workCollection, entryType } =
    workTypes.byEntryCollection(collection) ?? {}

  return mongo((db) => db
    .collection(collection)
    .aggregate(toUserEntriesPipeline({ userId, workCollection, limit }))
    .toArray()
    .then((arr) => arr.map((row) => toEntryWithMetadata(row, entryType)))
  )
}

/**
 * How many of a user's entries carry each score, counted by the database.
 *
 * The one function here that does not hand back documents: these rows are
 * `{ _id, count }` counts rather than stored documents, so `_id` here is a
 * score and not an id to act on. `toScoreTally` in ../score_tallies.js turns
 * them into the shape that gets stored.
 *
 * @type {(collection: ValidCollection, userId: string) => Promise<{ _id: any, count: number }[]>}
 */
const _countScoresByValue = (collection, userId) =>
  mongo((db) => db
    .collection(collection)
    .aggregate(toScoreTallyPipeline({ userId }))
    .toArray()
  )

module.exports = {
  _findOne,
  _findMany,
  _countScoresByValue,
  _findOneByField,
  _findOneByRef,
  _findAllByFieldIn,
  _findAllUserEntriesWithMetadata,
  _updateOneByRef,
  _create,
  _deleteOneByRef,
  _deleteAllByField,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * One document, asked for as one document rather than read out of the whole
 * matching set — which for the `users`-by-`username` lookup that runs on
 * almost every request meant the user collection, to keep `[0]`.
 *
 * A miss is `null`, which is what the driver says and what every caller here
 * now tests. It used to be `{}`, so that a caller could spread it or read
 * `?.data` off it without checking — and a caller that instead reached
 * straight in got `{}.data.userId`, which throws where neverthrow does not
 * catch. That was #139, and `null` is the answer to it.
 * @type {(collection: ValidCollection, filter: {}, options?: QueryOptions) => Promise<any | null>}
 */
const findFirst = (collection, filter, options) =>
  mongo((db) => db
    .collection(collection)
    .findOne(filter, toFindOptions(options))
  )

/**
 * `aggregate([{ $match: filter }])` returns the same documents, but a pipeline
 * is the wrong thing to hand a limit or a projection to.
 * @type {(collection: ValidCollection, filter: {}, options?: QueryOptions) => Promise<any[]>}
 */
const find = (collection, filter, options) =>
  mongo((db) => db
    .collection(collection)
    .find(filter, toFindOptions(options))
    .toArray()
  )

/** @type {(collection: ValidCollection, data: any, session?: ClientSession) => Promise<any>} */
const unsafeCreateDoc = (collection, data, session) =>
  mongo((db) => db
    .collection(collection)
    .insertOne({
      _id: randomUUID(),
      ...data,
    }, { session })
    // Read back through the same session: an insert made inside a transaction
    // is invisible to anything outside it until the transaction commits, so
    // without this the document just created would come back as a miss.
    .then(({ insertedId }) =>
      findFirst(collection, { _id: insertedId }, { session })
    )
  )
