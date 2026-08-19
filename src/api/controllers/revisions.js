/**
 * @file An entry's edit history and its autosaved draft.
 *
 * Both live in the `entryRevisions` collection, told apart by `kind`:
 *
 * - `revision`: what the entry looked like before a save replaced it. Written
 *   by the entries controller, never by the client, so history can't be
 *   forged or skipped.
 * - `draft`: the edit-in-progress the form autosaves, one per entry. It is
 *   what survives a closed tab or a browser crash, and it is deleted as soon
 *   as the entry is saved.
 *
 * Everything here is owner-only: the lists on the site are public, but what
 * someone typed and then deleted is not.
 */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
const { combine, okAsync } = require('neverthrow')
const responses = require('../utils/responses')
const db = require('../utils/db/')
const parsers = require('../utils/parsers')
const {
  getUserId,
  getSegment,
  getReqBody,
  toEntryCollection,
  toEntryType,
  toReviewCollection,
} = require('./utils')
const { triplet, toPromise, warn } = require('../utils/general')
const {
  toSnapshot,
  hasChanges,
  toVersionList,
  revisionsToPrune,
} = require('../utils/revision_history')

const COLLECTION = 'entryRevisions'

/**
 * The whole version list of an entry, newest first, starting with the entry
 * as it stands now, each version carrying what it changed.
 * @type {(event: Event) => Promise<Response>}
 */
const getVersions = (event) =>
  withOwnedEntry(event, async ({ collection, entry }) => {
    const review = await findReview(collection, entry._id)
    const revisions = await findRevisions(entry._id)

    return responses.ok({
      versions: toVersionList(
        {
          id: 'current',
          createdDate: entry.updatedDate ?? null,
          snapshot: toSnapshot(entry, review?.text),
        },
        revisions.map((revision) => ({
          id: revision._id,
          createdDate: revision.createdDate,
          supersededDate: revision.supersededDate,
          snapshot: revision.snapshot,
        }))
      ),
    })
  })

/** @type {(event: Event) => Promise<Response>} */
const getDraft = (event) =>
  withOwnedEntry(event, async ({ userId, entry }) => {
    const draft = await findDraft(entry._id, userId)

    return responses.ok({
      draft: draft
        ? { createdDate: draft.createdDate, snapshot: draft.snapshot }
        : null,
    })
  })

/** @type {(event: Event) => Promise<Response>} */
const saveDraft = (event) =>
  withOwnedEntry(event, async ({ userId, entryType, entry }) => {
    const body = getReqBody(event)
    if (body.isErr()) return responses.fromError(body.error)

    // Validated here rather than only on the way into the database, so that
    // the update path (which doesn't go through a parser) can't store
    // whatever the client felt like sending.
    const draft = parsers[COLLECTION]({
      entryRef: entry._id,
      entryType,
      userId,
      kind: 'draft',
      createdDate: Date.now(),
      snapshot: body.value,
    })
    if (draft.isErr()) return responses.fromError(draft.error)

    const existing = await findDraft(entry._id, userId)

    return existing
      ? db.updateByRef(COLLECTION, existing._id, draft.value)
      : db.create(COLLECTION, draft.value)
  })

/** @type {(event: Event) => Promise<Response>} */
const deleteDraft = (event) =>
  withOwnedEntry(event, async ({ userId, entry }) => {
    const draft = await findDraft(entry._id, userId)

    return draft
      ? db.deleteByRef(COLLECTION, draft._id)
      : responses.ok({ deleted: 0 })
  })

/**
 * Stores what the entry looked like *before* the save that is about to
 * happen. The entry itself is the current version, so only superseded ones
 * are kept here.
 *
 * History is a convenience: a failure to record it must never fail the save
 * that the user actually asked for.
 *
 * @type {(args: { entryType: string, entry: any, previousReview?: string, nextSnapshot: object }) => Promise<void>}
 */
const recordRevision = async ({
  entryType,
  entry,
  previousReview,
  nextSnapshot,
}) => {
  try {
    const previous = toSnapshot(entry, previousReview)
    if (!hasChanges(previous, nextSnapshot)) return

    const now = Date.now()
    const created = await db.create_(COLLECTION, {
      entryRef: entry._id,
      entryType,
      userId: entry.userId,
      kind: 'revision',
      // An entry without an `updatedDate` has no known save time, and "as of
      // the moment it was replaced" is the closest honest answer.
      createdDate: entry.updatedDate ?? now,
      supersededDate: now,
      snapshot: previous,
    })
    if (created.isErr()) {
      warn(`Could not record a revision for ${entry._id}: ${created.error}`)
      return
    }

    await pruneRevisions(entry._id)
  } catch (error) {
    warn(`Could not record a revision for ${entry?._id}: ${error}`)
  }
}

/** @type {(entryRef: string, userId: string) => Promise<void>} */
const discardDraft = async (entryRef, userId) => {
  const draft = await findDraft(entryRef, userId)
  if (draft) await db.deleteByRef_(COLLECTION, draft._id).unwrapOr(undefined)
}

/** Called when an entry is deleted: its history has nothing left to describe. */
/** @type {(entryRef: string) => Promise<void>} */
const discardHistory = (entryRef) =>
  db.deleteAllByField_(COLLECTION, 'entryRef', entryRef).unwrapOr(undefined)

module.exports = {
  getVersions,
  getDraft,
  saveDraft,
  deleteDraft,
  recordRevision,
  discardDraft,
  discardHistory,
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Resolves `/:type/:entryRef`, checks the caller owns that entry, and only
 * then hands over to the handler. Anything else is a 401 — including an
 * entry that doesn't exist, so this can't be used to probe for ids.
 * @type {(event: Event, respond: (args: { userId: string, entryType: string, collection: ValidCollection, entry: any }) => Promise<Response>) => Promise<Response>}
 */
const withOwnedEntry = (event, respond) => toPromise(
  toEntryCollection(getSegment(0, event))
    .asyncAndThen((collection) =>
      combine(triplet([
        getUserId(event),
        okAsync(collection),
        db.findOneByRef_(collection, getSegment(1, event)),
      ]))
    )
    .map(([userId, collection, entry]) =>
      entry?.userId === userId
        ? respond({
            userId,
            entryType: toEntryType(collection),
            collection,
            entry,
          })
        : responses.unauthorized()
    )
    .mapErr(responses.fromError)
)

/**
 * What the version list renders. `snapshot` is the bulk of a revision and the
 * whole point of one; the rest of the document — the entry it belongs to, its
 * type, its owner, its `kind` — the caller already knows.
 */
const VERSION_FIELDS = { createdDate: 1, supersededDate: 1, snapshot: 1 }

/** Pruning decides on dates alone, so it has no reason to read 50 notes. */
const PRUNE_FIELDS = { createdDate: 1 }

/** @type {(entryRef: string, projection?: object) => Promise<any[]>} */
const findRevisions = (entryRef, projection = VERSION_FIELDS) =>
  db
    .findMany_(COLLECTION, { entryRef, kind: 'revision' }, { projection })
    .unwrapOr([])

/**
 * There is one draft per entry per user, which is two fields to ask on. Asking
 * on `entryRef` alone meant reading every revision of the entry — up to 50
 * snapshots, each carrying a full copy of the note — to keep one document.
 * @type {(entryRef: string, userId: string) => Promise<any | null>}
 */
const findDraft = (entryRef, userId) =>
  db
    .findOne_(COLLECTION, { entryRef, userId, kind: 'draft' })
    .unwrapOr(null)

/** @type {(collection: ValidCollection, entryRef: string) => Promise<any | null>} */
const findReview = (collection, entryRef) =>
  db
    .findOneByField_(toReviewCollection(collection), 'entryRef', entryRef)
    .unwrapOr(null)

const pruneRevisions = async (entryRef) => {
  const revisions = await findRevisions(entryRef, PRUNE_FIELDS)
  for (const id of revisionsToPrune(revisions)) {
    await db.deleteByRef_(COLLECTION, id).unwrapOr(undefined)
  }
}
