/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
import { ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow'
import { getSegment, toEntryCollection, toReviewCollection } from './utils.js'
import { pair, toPromise } from '../utils/general.js'
import * as errors from '../utils/errors.js'
import * as responses from '../utils/responses.js'
import * as db from '../utils/db/index.js'
/**
 * GET /api/reviews/:type/:entryRef
 *
 * The `data` wrapper is this route's wire contract, spelled out here rather
 * than taken from the db module: the note panel reads `review?.data?.text`,
 * and a bundle cached before this change still does. An entry with no note
 * answers 200 with an empty body, which is what that `?.` turns into the
 * placeholder.
 *
 * An id that names no entry is a 404, and one that could not be an id at all
 * is a 400. Both used to be that same `200 {}`, so a note nobody wrote and an
 * entry that does not exist were one answer. #477.
 *
 * The entry is looked for alongside the review rather than before it, so
 * telling the two apart costs no round trip the panel did not already wait on.
 * @type {(event: Event) => Promise<Response>}
 */
const getReview = (event) => toPromise(
  toEntryCollection(getSegment(0, event))
    .andThen((collection) =>
      toEntryId(getSegment(1, event)).map((entryId) => [collection, entryId])
    )
    .asyncAndThen(([collection, entryId]) =>
      ResultAsync.combine(pair([
        findEntryOrFail(collection, entryId),
        db.findOneByField_(toReviewCollection(collection), 'entryRef', entryId),
      ]))
    )
    .map(([, review]) => review ? { data: review } : {})
    .map(responses.ok)
    .mapErr(responses.fromError)
)

export {
  getReview,
}
///////////////////////////////////////////////////////////////////////////////

/**
 * Loose on purpose. Entry ids have been three shapes — Fauna's numbers, then
 * ObjectId hex, then uuids from `randomUUID` — and a rule naming each would
 * turn a fourth into a 400 on a real entry. What this refuses is what no era
 * minted: punctuation, whitespace, an encoded operator, a novel's worth of
 * characters. Anything shaped like an id goes on to be looked up, and a miss
 * is the 404 below.
 */
const ENTRY_ID = /^[A-Za-z0-9-]{1,64}$/

/** @type {(segment: string) => import('neverthrow').Result<string, Error>} */
const toEntryId = (segment) =>
  ENTRY_ID.test(segment ?? '')
    ? ok(segment)
    : err(errors.req(undefined, 'not an entry id'))

/**
 * Only whether it is there, so only the `_id` is read. No `detail` on the
 * miss, for the reason `findOneByFieldOrFail_` gives: this route is public,
 * and `fromError` logs every detail it is handed.
 * @type {(collection: ValidCollection, entryId: string) => ResultAsync<any, Error>}
 */
const findEntryOrFail = (collection, entryId) =>
  db.findOne_(collection, { _id: entryId }, { projection: { _id: 1 } })
    .andThen((entry) => entry ? okAsync(entry) : errAsync(errors.notFound()))
