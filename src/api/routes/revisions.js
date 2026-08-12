/** @file revisions: an entry's edit history and its autosaved draft */
/** @typedef {import('@netlify/functions').Handler} Handler */
const responses = require('../utils/responses')
const {
  getVersions,
  getDraft,
  saveDraft,
  deleteDraft,
} = require('../controllers/revisions')
const { getSegment } = require('../controllers/utils')
const { matchVerbAndNumberOfUrlSegments } = require('../router')

/** The third segment only ever names the draft. */
const isDraft = (event) => getSegment(2, event) === 'draft'

/** @type Handler */
exports.handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/revisions/:type/:dbRef
    .with(['GET', 2], () => getVersions(event))

    // GET /api/revisions/:type/:dbRef/draft
    .with(['GET', 3], () =>
      isDraft(event) ? getDraft(event) : responses.notFound()
    )

    // PUT /api/revisions/:type/:dbRef/draft
    .with(['PUT', 3], () =>
      isDraft(event) ? saveDraft(event) : responses.notFound()
    )

    // DELETE /api/revisions/:type/:dbRef/draft
    .with(['DELETE', 3], () =>
      isDraft(event) ? deleteDraft(event) : responses.notFound()
    )

    .otherwise(() => responses.notFound())
