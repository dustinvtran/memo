/**
 * @file These functions may throw and should be considered
 * private to this module. They must be converted to safe
 * promises or safe ResultAsyncs with toPromise or toResult
 * pefore being re-exported.
 */
/** @typedef {import('../parsers').ValidCollection} ValidCollection */
/** @typedef {import('mongodb').ObjectId} ObjectId */
const { mongo } = require('./db')
const { v4: uuidv4 } = require('uuid')
const { throwIt } = require('../general')
const parsers = require('../parsers/')
const { toSameFormatAsFaunaDb, toEntryWithMetadata } = require('./shapes')
const { toUserEntriesPipeline, toFindOptions } = require('./queries')

/** @typedef {import('./queries').QueryOptions} QueryOptions */

/**
 * A whole filter document, so a query can name more than one field, and the
 * options to go with it. `findDraft` is the reason: one draft per entry per
 * user is two fields, and asking on one of them meant reading every revision
 * of the entry — up to 50 snapshots, each carrying a full copy of the note —
 * to keep the one document that matched both.
 * @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => Promise<object>}
 */
const _findOne = (collection, filter, options) =>
  findFirst(collection, filter, options)

/** @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => Promise<object>} */
const _findMany = (collection, filter, options) =>
  find(collection, filter, options)

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<object>} */
const _findOneByField = (collection, field, value) =>
  findFirst(collection, { [field]: value })

/** @type {(collection: ValidCollection, ref: string) => Promise<object>} */
const _findOneByRef = (collection, ref) =>
  findFirst(collection, { _id: ref })

/** @type {(collection: ValidCollection) => Promise<object>} */
const _findAllInCollection = (collection) =>
  find(collection, {})

/**
 * One query for many values of the same field, rather than one query per
 * value. A whole list's reviews are 400-odd `entryRef`s, and 400 round trips
 * is the difference between a response and a function timeout.
 * @type {(collection: ValidCollection, field: string, values: any[], options?: QueryOptions) => Promise<object>}
 */
const _findAllByFieldIn = (collection, field, values, options) =>
  values.length === 0
    ? Promise.resolve([])
    : find(collection, { [field]: { $in: values } }, options)

/** @type {(collection: ValidCollection, ref: string, update: any) => Promise<object>} */
const _updateOneByRef = (collection, ref, update) =>
  mongo((db) => db
    .collection(collection)
    .updateOne({ _id: ref }, { $set: update })
  )

/** @type {(collection: ValidCollection, ref: string) => Promise<object>} */
const _deleteOneByRef = (collection, ref) =>
  mongo((db) => db
    .collection(collection)
    .deleteOne({ _id: ref })
  )

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<object>} */
const _deleteAllByField = (collection, field, value) =>
  mongo((db) => db
    .collection(collection)
    .deleteMany({ [field]: value })
  )

/** @type {(collection: ValidCollection, data: any) => Promise<object>} */
const _create = (collection, data) =>
  parsers[collection](data).match(
    (validDoc) => unsafeCreateDoc(collection, validDoc),
    (err) => throwIt(err)
  )

/**
 * A whole list in one query. The ordering and the limit are the database's
 * job rather than this function's, so a limited request joins the metadata
 * onto the entries it is going to return instead of onto all of them.
 *
 * @type {(collection: 'filmEntries' | 'gameEntries' | 'tvShowEntries' | 'bookEntries', userId: string, limit?: number) => Promise<object>}
 */
const _findAllUserEntriesWithMetadata = async (collection, userId, limit) => {
  const workCollection = {
    filmEntries: 'films',
    gameEntries: 'games',
    tvShowEntries: 'tvShows',
    bookEntries: 'books',
  }[collection]
  const entryType = {
    filmEntries: 'Film',
    gameEntries: 'Game',
    tvShowEntries: 'TVShow',
    bookEntries: 'Book',
  }[collection]

  const results = await mongo((db) => db
    .collection(collection)
    .aggregate(toUserEntriesPipeline({ userId, workCollection, limit }))
    .toArray()
    .then((arr) => arr.map((row) => toEntryWithMetadata(row, entryType)))
  )

  return { data: results }
}

module.exports = {
  _findOne,
  _findMany,
  _findOneByField,
  _findOneByRef,
  _findAllInCollection,
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
 * @type {(collection: ValidCollection, filter: {}, options?: QueryOptions) => Promise<object>}
 */
const findFirst = (collection, filter, options) =>
  mongo((db) => db
    .collection(collection)
    .findOne(filter, toFindOptions(options))
    // Absent stays `{}` rather than becoming `null`: callers test `?.data` or
    // `?.ref` on what comes back, and some of them spread it.
    .then((dcmt) => (dcmt ? toSameFormatAsFaunaDb(dcmt) : {}))
  )

/**
 * `aggregate([{ $match: filter }])` returns the same documents, but a pipeline
 * is the wrong thing to hand a limit or a projection to.
 * @type {(collection: ValidCollection, filter: {}, options?: QueryOptions) => Promise<object>}
 */
const find = (collection, filter, options) =>
  mongo((db) => db
    .collection(collection)
    .find(filter, toFindOptions(options))
    .toArray()
    .then((arr) => arr.map(toSameFormatAsFaunaDb))
  )

/** @type {(collection: ValidCollection, data: any) => Promise<object>} */
const unsafeCreateDoc = (collection, data) =>
  mongo((db) => db
    .collection(collection)
    .insertOne({
      _id: uuidv4(),
      ...data,
    })
    .then(({ insertedId }) =>
      findFirst(collection, { _id: insertedId })
    )
  )
