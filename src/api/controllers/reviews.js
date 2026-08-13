/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
const { getSegment } = require('./utils')
const responses = require('../utils/responses')
const db = require('../utils/db/')
const workTypes = require('../utils/work_types')

/** @type {(event: Event) => Promise<Response>} */
const getReview = async (event) => {
  const entryType = getSegment(0, event)
  const entryId = getSegment(1, event)

  const collection = workTypes.byType(entryType)?.reviews

  return collection != null
    ? db.findOneByField(collection, 'entryRef', entryId)
    : responses.notFound()
}

module.exports = {
  getReview,
}
