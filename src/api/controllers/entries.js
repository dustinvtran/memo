/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const { combine, okAsync } = require('neverthrow')
const {
  getUserId,
  getSegment,
  getReqBody,
  findIdOfName,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
} = require('./utils')
const { triplet, quad, toPromise, toAsync } = require('../utils/general')
const db = require('../utils/db/')
const { toResponse } = require('../utils/db/into_safe_values')
const { recordRevision, discardDraft, discardHistory } = require('./revisions')
const { toSnapshot } = require('../utils/revision_history')

/** @type {(event: Event) => Promise<Response>} */
const getAllEntriesForUser = (event) => toPromise(
  combine(triplet([
    findIdOfName(getSegment(1, event)),
    toAsync(toEntryCollection(getSegment(0, event))),
    okAsync(getSegment(2, event))
  ]))
    .map(getUserEntries)
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const createNewUserListEntry = (event) => toPromise(
  combine(triplet([
    getUserId(event),
    getReqBody(event),
    toEntryCollection(getSegment(0, event)),
  ]))
    .asyncMap(createEntry)
    .mapErr(responses.fromError)
)

/** @type {(event: Event, context: Context) => Promise<Response>} */
const updateEntry = (event) => toPromise(
  toEntryCollection(getSegment(0, event))
    .asyncAndThen((col) =>
      combine(quad([
        toAsync(getUserId(event)),
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
      combine(triplet([
        toAsync(getUserId(event)),
        okAsync(col),
        db.findOneByRef_(col, getSegment(1, event)),
      ]))
    )
    .map(([uid, col, entry]) =>
      entry.data?.userId === uid
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
    .map(({ data }) => data.map(({ entry, work }) => ({
      ...entry.data,
      commonMetadata: work.data,
      dbRef: entry.ref.id
    })))
))

/** @type {([userId, body, collection]: [string, any, ValidCollection]) => Promise<Response>} */
const createEntry = ([userId, body, collection]) => {
  const { review, ...entryWithoutReview } = body
  const reviewCollection = toReviewCollection(collection)

  return db.create_(collection, { ...entryWithoutReview, userId, updatedDate: Date.now() })
    .andThen((entry) => db.create_(reviewCollection, {
      text: review,
      entryRef: entry.ref.id,
    }))
    // `fromError`, not `internalError`: the latter would send the error object
    // itself, detail and all, back as the body.
    .match(responses.ok, responses.fromError)
}

/** @type {(col: ValidCollection, entry: any) => Promise<Response>} */
const deleteEntry_ = async (col, entry) => {
  const response = await db.deleteByRef(col, entry.ref.id)

  // The history and the draft only describe an entry that no longer exists.
  await discardHistory(entry.ref.id)

  // The review is only ever found by `entryRef`, so leaving it behind doesn't
  // hide it — it stores a note the user asked to be rid of, unreachable by
  // every code path. Its failure is swallowed for the same reason the
  // history's is: a cleanup must not fail the delete the user asked for.
  await db.deleteAllByField_(toReviewCollection(col), 'entryRef', entry.ref.id).unwrapOr(undefined)

  return response
}

const updateEntry_ = async (uid, body, col, entry) => {
  if (entry.data.userId !== uid) return responses.unauthorized()

  const { review, ...entryWithoutReview } = body
  // `review` is only absent when the request genuinely omitted it (e.g. a save
  // that didn't include the comments field). An explicit empty string is a
  // real value and must still clear the review. Treating "absent" as "clear"
  // previously nulled out review text on unrelated saves.
  const reviewProvided = review !== undefined

  const reviewCollection = toReviewCollection(col)

  const existingReview = await db
    .findOneByField_(reviewCollection, 'entryRef', entry.ref.id)
    .unwrapOr({})

  // Recorded before anything is written, so the version this save replaces —
  // the long note included — can be read back and restored from the UI.
  await recordRevision({
    entryType: toEntryType(col),
    entry,
    previousReview: existingReview?.data?.text,
    nextSnapshot: toSnapshot(
      { ...entry.data, ...entryWithoutReview },
      reviewProvided ? review : existingReview?.data?.text
    ),
  })

  if (reviewProvided) {
    // Awaited so the write completes before the function returns; a
    // serverless container can be frozen right after the response is sent.
    await (existingReview?.ref
      ? db.updateByRef_(reviewCollection, existingReview.ref.id, { text: review })
      // Shouldn't be needed, but just in case.
      : db.create_(reviewCollection, {
          text: review,
          entryRef: entry.ref.id,
        }))
  }

  const response = await db.updateByRef(col, entry.ref.id, {
    ...(reviewProvided ? body : entryWithoutReview),
    updatedDate: Date.now(),
  })

  // The draft has been saved for real now, so it has nothing left to recover.
  await discardDraft(entry.ref.id, uid)

  return response
}

