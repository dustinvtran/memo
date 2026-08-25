/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const errors = require('../utils/errors')
const { identity } = require('ramda')
const { ResultAsync, okAsync } = require('neverthrow')
const {
  getUserId,
  getSegment,
  getReqBody,
  findIdOfName,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
} = require('./utils')
const { triplet, quad, toPromise, toAsync, throwIt } = require('../utils/general')
const db = require('../utils/db/')
const updateParsers = require('../utils/parsers/updates')
const { toResponse } = require('../utils/db/into_safe_values')
const { recordRevision, discardDraft, discardHistory } = require('./revisions')
const { toSnapshot } = require('../utils/revision_history')

/** @type {(event: Event) => Promise<Response>} */
const getAllEntriesForUser = (event) => toPromise(
  ResultAsync.combine(triplet([
    findIdOfName(getSegment(1, event)),
    toAsync(toEntryCollection(getSegment(0, event))),
    okAsync(getSegment(2, event))
  ]))
    .map(getUserEntries)
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const createNewUserListEntry = (event) => toPromise(
  ResultAsync.combine(triplet([
    getUserId(event),
    toAsync(getReqBody(event)),
    toAsync(toEntryCollection(getSegment(0, event))),
  ]))
    .map(createEntry)
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const updateEntry = (event) => toPromise(
  toEntryCollection(getSegment(0, event))
    .asyncAndThen((col) =>
      ResultAsync.combine(quad([
        getUserId(event),
        toAsync(getReqBody(event)),
        okAsync(col),
        db.findOneByRef_(col, getSegment(1, event)),
      ]))
    )
    .map(([uid, body, col, entry]) => updateEntry_(uid, body, col, entry))
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const deleteEntry = (event) => toPromise(
  toEntryCollection(getSegment(0, event))
    .asyncAndThen((col) =>
      ResultAsync.combine(triplet([
        getUserId(event),
        okAsync(col),
        db.findOneByRef_(col, getSegment(1, event)),
      ]))
    )
    .map(([uid, col, entry]) =>
      entry?.userId === uid
        ? deleteEntry_(col, entry)
        : responses.unauthorized()
    )
    .mapErr(responses.fromError)
)


module.exports = {
  getAllEntriesForUser,
  createNewUserListEntry,
  updateEntry,
  deleteEntry,
}

////////////////////////////////////////////////////////////////////////////////

/** @type {([uid, col, limit]: [string, ValidCollection, string | undefined]) => Promise<any>} */
const getUserEntries = ([uid, col, limit]) => toResponse(toPromise(
  db.findAllUserEntriesWithMetadata_(col, uid, parseInt(limit ?? '') || undefined)
    .map((rows) => rows.map(({ entry, work }) => ({
      ...entry,
      commonMetadata: work,
      dbRef: entry._id
    })))
))

/** @type {([userId, body, collection]: [string, any, ValidCollection]) => Promise<Response>} */
const createEntry = async ([userId, body, collection]) => {
  const { review, ...entryWithoutReview } = body
  const reviewCollection = toReviewCollection(collection)

  try {
    // An entry and its note are one thing to the person saving them, so they
    // are one transaction. Written separately, a failure on the second left
    // an entry no note could ever be attached to — reported to the user as a
    // failure that had nonetheless half happened.
    const entry = await db.withTransaction(async (session) => {
      const created = await orThrow(db.create_(collection, {
        ...entryWithoutReview,
        userId,
        updatedDate: Date.now(),
      }, session))

      await orThrow(db.create_(reviewCollection, {
        text: review,
        entryRef: created._id,
      }, session))

      return created
    })

    // The entry, not the review it ends with: this response is the only place
    // the caller can learn the id of what it just created.
    return responses.ok(entry)
  } catch (error) {
    return failed(error)
  }
}

/** @type {(col: ValidCollection, entry: any) => Promise<Response>} */
const deleteEntry_ = async (col, entry) => {
  const response = await db.deleteByRef(col, entry._id)

  // The history and the draft only describe an entry that no longer exists.
  await discardHistory(entry._id)

  // The review is only ever found by `entryRef`, so leaving it behind doesn't
  // hide it — it stores a note the user asked to be rid of, unreachable by
  // every code path. Its failure is swallowed for the same reason the
  // history's is: a cleanup must not fail the delete the user asked for.
  await db.deleteAllByField_(toReviewCollection(col), 'entryRef', entry._id).unwrapOr(undefined)

  return response
}

const updateEntry_ = async (uid, body, col, entry) => {
  if (entry?.userId !== uid) return responses.unauthorized()

  const { review, ...rest } = body
  // `review` is only absent when the request genuinely omitted it (e.g. a save
  // that didn't include the comments field). An explicit empty string is a
  // real value and must still clear the review. Treating "absent" as "clear"
  // previously nulled out review text on unrelated saves.
  const reviewProvided = review !== undefined

  // `updateByRef_` writes what it is handed, so this is the only thing between
  // the request body and the document. Without it a caller could set `userId`
  // and move the entry into someone else's list, and the form's own
  // `commonMetadata: null` was being stored on every save. See #171.
  const parsed = updateParsers[col](rest)
  if (parsed.isErr()) return responses.fromError(parsed.error)
  const entryWithoutReview = parsed.value

  const reviewCollection = toReviewCollection(col)

  const existingReview = await db
    .findOneByField_(reviewCollection, 'entryRef', entry._id)
    .unwrapOr(null)

  // Recorded before anything is written, so the version this save replaces —
  // the long note included — can be read back and restored from the UI.
  //
  // Deliberately outside the transaction below. History is a convenience and
  // its failure must never fail the save (see revisions.js), but a write that
  // fails inside a transaction aborts it, which is precisely the wrong way
  // round. The price is that a save that then rolls back leaves a version
  // recording the state that is still current; noise on a path the user is
  // already being shown an error on.
  await recordRevision({
    entryType: toEntryType(col),
    entry,
    previousReview: existingReview?.text,
    nextSnapshot: toSnapshot(
      { ...entry, ...entryWithoutReview },
      reviewProvided ? review : existingReview?.text
    ),
  })

  try {
    // The entry and its note go together or not at all. Both writes are
    // awaited inside the transaction so they complete before the function
    // returns; a serverless container can be frozen right after the response
    // is sent.
    const written = await db.withTransaction(async (session) => {
      // The entry first. Against a replica set the order does not matter —
      // either both land or neither does — but `withTransaction` degrades to
      // plain writes on a deployment that cannot transact, and there an entry
      // left stale beside a fresh note is the more confusing of the two
      // half-saves: the score and the dates say one thing, the comments
      // another. A stale note beside a fresh entry at least looks like what
      // it is.
      //
      // `entryWithoutReview` and not `body`: the note is written to the
      // reviews collection just below, and a second copy of it on the entry is
      // what put 1.9 MB of duplicated note into production. #171, #176.
      const updated = await orThrow(db.updateByRef_(col, entry._id, {
        ...entryWithoutReview,
        updatedDate: Date.now(),
      }, session))

      if (reviewProvided) {
        await orThrow(existingReview
          ? db.updateByRef_(reviewCollection, existingReview._id, { text: review }, session)
          // Shouldn't be needed, but just in case.
          : db.create_(reviewCollection, {
              text: review,
              entryRef: entry._id,
            }, session))
      }

      return updated
    })

    // The draft has been saved for real now, so it has nothing left to
    // recover. Outside the transaction, and after it: a draft left behind by
    // a save that rolled back still describes edits the user has not managed
    // to store, which is exactly what a draft is for.
    await discardDraft(entry._id, uid)

    return responses.ok(written)
  } catch (error) {
    return failed(error)
  }
}

/**
 * The `_`-suffixed db helpers answer with a Result rather than throwing, and
 * a transaction is only told to roll back by a rejected promise. This is the
 * join between the two.
 * @type {(result: import('neverthrow').ResultAsync<any, Error>) => Promise<any>}
 */
const orThrow = async (result) => (await result).match(identity, throwIt)

/**
 * A write that failed inside a transaction arrives here as whatever was
 * thrown: an `Error` from the db helpers, or something the driver raised on
 * the transaction itself. Either way it leaves through `fromError`, which
 * logs what it knows and tells the caller only the class of failure — the
 * driver's own account of one names every host it tried. See #105.
 * @type {(error: any) => Response}
 */
const failed = (error) =>
  responses.fromError(typeof error?.error === 'string' ? error : errors.db(error))

