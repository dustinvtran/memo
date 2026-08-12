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

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<object>} */
const _findOneByField = (collection, field, value) =>
  findFirst(collection, { [field]: value })

/** @type {(collection: ValidCollection, ref: string) => Promise<object>} */
const _findOneByRef = (collection, ref) =>
  findFirst(collection, { _id: ref })

/** @type {(collection: ValidCollection) => Promise<object>} */
const _findAllInCollection = (collection) =>
  findAll(collection, {})

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<object>} */
const _findAllByField = (collection, field, value) =>
  findAll(collection, { [field]: value })

/**
 * One query for many values of the same field, rather than one query per
 * value. A whole list's reviews are 400-odd `entryRef`s, and 400 round trips
 * is the difference between a response and a function timeout.
 * @type {(collection: ValidCollection, field: string, values: any[]) => Promise<object>}
 */
const _findAllByFieldIn = (collection, field, values) =>
  values.length === 0
    ? Promise.resolve([])
    : findAll(collection, { [field]: { $in: values } })

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
    .aggregate([
      { $match: { userId } },
      // The order the caller used to sort into after the fact. A missing
      // `updatedDate` sorts last here too. `_id` only breaks ties, of which
      // there are a great many — a bulk import stamps a whole list with one
      // millisecond — and it breaks them the same way every time, which the
      // sort it replaces did not: that one left entries stamped the same
      // millisecond in whatever order the database happened to return them.
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
      // Nobody reads either of these from a list, and they are not small:
      // `review` is the whole note, which the reviews endpoint serves when a
      // row is actually opened, and `userId` is an auth0 id repeated once per
      // entry for anyone who asks for the list.
      { $project: { review: 0, userId: 0 } },
    ])
    .toArray()
    .then((arr) => arr.map((row) => toEntryWithMetadata(row, entryType)))
  )

  return { data: results }
}

module.exports = {
  _findOneByField,
  _findOneByRef,
  _findAllInCollection,
  _findAllByField,
  _findAllByFieldIn,
  _findAllUserEntriesWithMetadata,
  _updateOneByRef,
  _create,
  _deleteOneByRef,
  _deleteAllByField,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(collection: ValidCollection, filter: {}) => Promise<object>} */
const findFirst = (collection, filter) =>
  find(collection, filter).then((results) => results[0] ?? {})

/** @type {(collection: ValidCollection, filter: {}) => Promise<object>} */
const findAll = (collection, filter) =>
  find(collection, filter)

/** @type {(collection: ValidCollection, filter: {}) => Promise<object>} */
const find = (collection, filter) =>
  mongo((db) => db
    .collection(collection)
    .aggregate([{ $match: filter }])
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
