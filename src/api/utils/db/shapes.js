/**
 * @file The shapes the db module hands out, without the database.
 *
 * `db.js` builds a MongoClient at require time and throws without
 * `MONGODB_URL`, so nothing in unsafe_functions.js can be reached from
 * `node --test`. What a query returns is worth testing even so — a wrong
 * shape reaches the page as a missing field rather than as an error — so the
 * shaping lives here, pure and dependency-free, and the queries call it.
 * See shapes.test.js.
 */

/**
 * @info This function exists because we migrated from FaunaDB to MongoDB.
 * @typedef {{ data: any, ref: { id: string }}} FaunaShaped
 * @type {(dcmt: any) => FaunaShaped}
 */
const toSameFormatAsFaunaDb = (dcmt) => ({
  data: dcmt,
  ref: { id: dcmt._id },
})

/**
 * One row of a list query: the entry, and beside it the work it points at.
 *
 * `work` comes off the entry rather than travelling with it. The caller
 * returns it as `commonMetadata`, and left in place it would also go back as
 * a second, identical copy on every entry — a third of the response.
 *
 * `$lookup` returns an array, empty when an entry's `workRef` names a work
 * that isn't there, so the stand-in is a work document with the one field the
 * page cannot do without: it reads `commonMetadata.entryType` off this, and
 * without it the row loses its type — no status label, and a review request
 * to `/api/reviews/undefined/:id`.
 *
 * @type {(row: any, entryType: string) => { entry: any, work: any }}
 */
const toEntryWithMetadata = ({ work, ...entry }, entryType) => ({
  entry,
  work: work?.[0] ?? { entryType },
})

module.exports = {
  toSameFormatAsFaunaDb,
  toEntryWithMetadata,
}
