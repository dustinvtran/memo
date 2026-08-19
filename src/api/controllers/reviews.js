/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
const { getSegment } = require('./utils')
const { toPromise } = require('../utils/general')
const responses = require('../utils/responses')
const db = require('../utils/db/')
const workTypes = require('../utils/work_types')

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

module.exports = {
  getReview,
}
