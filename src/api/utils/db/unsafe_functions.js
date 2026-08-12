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

/** @type {(collection: 'filmEntries' | 'gameEntries' | 'tvShowEntries' | 'bookEntries', userId: string, limit?: number) => Promise<object>} */
const _findAllUserEntriesWithMetadata = async (collection, userId, limit) => {
  console.log('in _findAllUserEntriesWithMetadata')
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
  const emptyWork = { data: { entryType } }

  const results = await mongo((db) => db
    .collection(collection)
    .aggregate([
      { $match: { userId } },
      {
        $lookup: {
          from: workCollection,
          localField: 'workRef',
          foreignField: '_id',
          as: 'work',
        },
      },
    ])
    .toArray()
    .then((arr) => arr
      .map(toSameFormatAsFaunaDb)
      .map((entry) => ({ entry, work: { data: entry.data.work?.[0] ?? emptyWork }}))
    )
  )

  const resultsByLastUpdatedIfPossible =
    [...results].sort((a, b) =>
      (b.entry?.data?.updatedDate ?? 0) - (a.entry?.data?.updatedDate ?? 0)
    )

  const finalResults =
    limit
      ? resultsByLastUpdatedIfPossible.slice(0, limit)
      : resultsByLastUpdatedIfPossible

  return { data: finalResults }
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

/**
 * @type {(docOrDocs: any) => { data: any, ref: { id: string }}}
 * @info This function exists because we migrated from FaunaDB to MongoDB.
 */
const toSameFormatAsFaunaDb = (dcmt) => ({
  data: dcmt,
  ref: { id: dcmt._id },
})

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
