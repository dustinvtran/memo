/**
 * @file A user's lists in one response, for readers that aren't browsers.
 *
 * The lists on the site are public but they are drawn client-side, so
 * fetching `https://nil.moe/films/nil` gets you an empty page and no data.
 * This is the same thing in a form a language model, a script or `curl` can
 * read: every entry with its metadata and its long note, as JSON or as
 * Markdown.
 *
 * Public, and deliberately so — it exposes exactly what the rendered page
 * already does. Drafts and edit history stay owner-only; see revisions.js.
 */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
const { combine } = require('neverthrow')
const responses = require('../utils/responses')
const errors = require('../utils/errors')
const db = require('../utils/db/')
const { getSegment, findIdOfName, toEntryCollection, toReviewCollection } = require('./utils')
const { safeJSONStringify, warn } = require('../utils/general')
const {
  ENTRY_TYPES,
  toExportList,
  toExportDocument,
  toMarkdown,
} = require('../utils/export_view')

/**
 * A Netlify function may return 6 MB, and going over is a 502 with nothing in
 * it to explain itself. All four of one heavy user's lists already come to
 * north of 4 MB, so the ceiling is real; this leaves headroom for the headers
 * and for a list that grew since the last time anyone checked.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * GET /api/export/:username           — every list
 * GET /api/export/:type/:username     — one list
 *
 * `?format=md` for Markdown; JSON otherwise. `?limit=N` keeps the N
 * most recently updated entries of each list, as `/api/entries` does.
 * @type {(event: Event) => Promise<Response>}
 */
const exportUserLists = async (event) => {
  const [entryTypes, username] = getSegment(1, event)
    ? [[getSegment(0, event)], getSegment(1, event)]
    : [ENTRY_TYPES, getSegment(0, event)]

  const collections = combine(entryTypes.map(toEntryCollection))
  // Whoever hit this is likely guessing at the url, so say what would have
  // worked rather than only that this didn't.
  if (collections.isErr()) {
    return responses.fromError(
      errors.notFound(`no such list type; try one of ${ENTRY_TYPES.join(', ')}`)
    )
  }

  const userId = await findIdOfName(username).unwrapOr(undefined)
  // A name nobody has taken and a name whose lists happen to be empty are
  // different things, and only the first is a 404.
  if (!userId) return responses.fromError(errors.notFound(`no such user: ${username}`))

  const limit = toLimit(event)
  const lists = await Promise.all(
    collections.value.map(async (collection, index) =>
      toExportList(entryTypes[index], await findListEntries(collection, userId, limit))
    )
  )

  const siteUrl = toSiteUrl(event)
  const document = toExportDocument({ username, lists, siteUrl })

  return wantsMarkdown(event)
    ? withinBudget('text/markdown; charset=utf-8', toMarkdown(document, siteUrl), username)
    : asJson(document, username)
}

module.exports = {
  exportUserLists,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * The entries of one list with their works and their notes. Two queries per
 * list: the entries joined to their works, then every note of those entries
 * at once.
 * @type {(collection: ValidCollection, userId: string, limit?: number) => Promise<object[]>}
 */
const findListEntries = async (collection, userId, limit) => {
  const rows = await db
    .findAllUserEntriesWithMetadata_(collection, userId, limit)
    .unwrapOr([])

  const reviews = await findReviews(
    toReviewCollection(collection),
    rows.map(({ entry }) => entry?._id).filter(Boolean)
  )

  return rows.map(({ entry, work }) => ({
    entry: entry ?? {},
    work: work ?? {},
    review: reviews.get(entry?._id),
  }))
}

/**
 * The notes of a whole list, keyed by the entry they belong to. A note the
 * user has since emptied is stored as an empty string, which is not something
 * to export.
 * @type {(collection: ValidCollection, entryRefs: string[]) => Promise<Map<string, string>>}
 */
const findReviews = async (collection, entryRefs) => {
  const found = await db
    .findAllByFieldIn_(collection, 'entryRef', entryRefs, {
      projection: { entryRef: 1, text: 1 },
    })
    .unwrapOr([])

  return new Map(
    (found ?? [])
      .filter((review) => review?.entryRef && review?.text)
      .map((review) => [review.entryRef, review.text])
  )
}

/**
 * The site this was fetched from, so the export can link back to the pages it
 * mirrors. Netlify gives the function the original request url in `rawUrl`.
 * @type {(event: Event) => string | undefined}
 */
const toSiteUrl = (event) => {
  try {
    return new URL(event.rawUrl).origin
  } catch (error) {
    warn(`Could not read the site url from ${event?.rawUrl}: ${error}`)
    return undefined
  }
}

/** @type {(event: Event) => boolean} */
const wantsMarkdown = (event) =>
  ['md', 'markdown', 'text'].includes(
    (event.queryStringParameters?.format ?? '').toLowerCase()
  )

/** @type {(event: Event) => number | undefined} */
const toLimit = (event) =>
  parseInt(event.queryStringParameters?.limit ?? '') || undefined

/**
 * Stringified here rather than by `responses.ok` because the byte budget
 * below has to weigh the body before it is sent, and a `Response` does not
 * say how big it is. `responses.ok` would set the same content type — it is
 * the same constant — but not the CORS header this route also needs.
 *
 * Not indented: it costs a quarter of the response and every reader of this,
 * browsers included, formats JSON itself.
 * @type {(body: object, username: string) => Response}
 */
const asJson = (body, username) =>
  safeJSONStringify(body).match(
    (text) => withinBudget(responses.JSON_CONTENT_TYPE, text, username),
    (error) => responses.fromError(errors.internal(error))
  )

/**
 * A body over the ceiling never reaches the caller, so say what happened and
 * what to ask for instead. Both suggestions are smaller by construction: one
 * list is a quarter of four, and a limit is whatever the caller can take.
 * @type {(contentType: string, body: string, username: string) => Response}
 */
const withinBudget = (contentType, body, username) =>
  Buffer.byteLength(body) <= MAX_BODY_BYTES
    ? asText(contentType, body)
    : responses.payloadTooLarge({
        error: 'These lists are too big to send in one response.',
        tryInstead: [
          ...ENTRY_TYPES.map((type) => `/api/export/${type}/${username}`),
          `/api/export/${username}?limit=200`,
        ],
      })

/** @type {(contentType: string, body: string) => Response} */
const asText = (contentType, body) => ({
  statusCode: 200,
  headers: {
    'content-type': contentType,
    // Public data, and reading it from a page or a notebook shouldn't need a
    // proxy.
    'access-control-allow-origin': '*',
  },
  body,
})
