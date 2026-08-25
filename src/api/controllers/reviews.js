/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
import { getSegment } from './utils.js'
import { toPromise } from '../utils/general.js'
import * as responses from '../utils/responses.js'
import * as db from '../utils/db/index.js'
import * as workTypes from '../utils/work_types.js'
/**
 * GET /api/reviews/:type/:entryRef
 *
 * The `data` wrapper is this route's wire contract, spelled out here rather
 * than taken from the db module: the note panel reads `review?.data?.text`,
 * and a bundle cached before this change still does. An entry with no note
 * answers 200 with an empty body, which is what that `?.` turns into the
 * placeholder.
 * @type {(event: Event) => Promise<Response>}
 */
const getReview = async (event) => {
  const entryType = getSegment(0, event)
  const entryId = getSegment(1, event)

  const collection = workTypes.byType(entryType)?.reviews

  if (collection == null) return responses.notFound()

  return toPromise(
    db.findOneByField_(collection, 'entryRef', entryId)
      .map((review) => review ? { data: review } : {})
      .map(responses.ok)
      .mapErr(responses.fromError)
  )
}

export {
  getReview,
}