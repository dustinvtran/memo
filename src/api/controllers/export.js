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
import { Result } from 'neverthrow'
import * as responses from '../utils/responses.js'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import { getSegment, findIdOfName, toEntryCollection, toReviewCollection } from './utils.js'
import { safeJSONStringify, warn } from '../utils/general.js'
import { LIST_TYPES, toExportUrls, toExportList, toExportDocument, toExportIndex, toMarkdown, toIndexMarkdown } from '../utils/export_view.js'
/**
 * A Netlify function may return 6 MB, and going over is a 502 with nothing in
 * it to explain itself. All four of one heavy user's lists already come to
 * north of 4 MB, so the ceiling is real; this leaves headroom for the headers
 * and for a list that grew since the last time anyone checked.
 *
 * #334 asked whether this should come down, so that a body too big to send in
 * a reasonable time fails fast and instructively rather than crawling towards
 * the 10-second function timeout. Measured against production, it should not:
 * `nil`'s largest single list is 2.94 MB, and anything low enough to stop the
 * 4.76 MB all-in-one response would `413` a per-type url — which is the url
 * the `413` tells the caller to fetch instead. The advice would be a loop.
 *
 * What #334 changed instead is which response the advertised url gives: the
 * one that recomputed all four lists is now an index, so the body this
 * ceiling governs is only ever one a caller asked for by name.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * How long a copy of a list is good for.
 *
 * Every request used to recompute the export from MongoDB — up to eight
 * queries, joins and all — and Netlify sends a function's response
 * `Cache-Control: no-cache` unless the function says otherwise, so the edge
 * and the durable cache both forwarded every hit (`Cache-Status: "Netlify
 * Durable"; fwd=bypass`). These are public, read-only lists that change a few
 * times a day at most, and the document carries the `updatedDate` of every
 * entry in it, so a reader can see for itself how old the numbers are.
 *
 * Invalidation is the clock and nothing else. Netlify has a cache-tag purge
 * API, and wiring the save path to it would mean an access token in the
 * function environment and a new failure mode on every write in exchange for
 * five minutes of freshness on a public list. The five minutes is the answer.
 *
 * `stale-while-revalidate` is the half that actually fixes #334. Past the five
 * minutes the edge serves the stored copy immediately and refetches in the
 * background, so the slow recompute stops being something a caller waits on —
 * a url fetched at least once a day never goes cold again, and going cold is
 * what put a 9.5-second response against a 10-second timeout.
 */
const CACHE_SECONDS = 5 * 60
const STALE_SECONDS = 24 * 60 * 60

/**
 * `Netlify-CDN-Cache-Control` is read by Netlify's edge alone and takes
 * precedence there over `Cache-Control`, which is what leaves the latter
 * meaning the browser and nothing else. `durable` opts the response into the
 * cache shared between edge nodes rather than the one node that invoked the
 * function, which is the difference between one region being warm and all of
 * them being.
 *
 * Nothing needs to declare a `Netlify-Vary`: the default for a function is
 * already `query`, so `?limit=`, `?format=` and the bare url are each cached
 * as the different documents they are.
 * https://docs.netlify.com/build/caching/caching-overview/
 */
const CACHE_HEADERS = {
  'cache-control': `public, max-age=${CACHE_SECONDS}`,
  'netlify-cdn-cache-control':
    `public, durable, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
}

/**
 * GET /api/export/:username           — an index of the lists
 * GET /api/export/:username?limit=N   — every list, N entries of each
 * GET /api/export/:type/:username     — one list
 *
 * `?format=md` for Markdown; JSON otherwise. `?limit=N` keeps the N
 * most recently updated entries of each list, as `/api/entries` does.
 * @type {(event: Event) => Promise<Response>}
 */
const exportUserLists = async (event) => {
  const namesType = Boolean(getSegment(1, event))
  const [types, username] = namesType
    ? [[getSegment(0, event)], getSegment(1, event)]
    : [LIST_TYPES, getSegment(0, event)]

  const collections = Result.combine(types.map(toEntryCollection))
  // Whoever hit this is likely guessing at the url, so say what would have
  // worked rather than only that this didn't. Second argument: `detail` is
  // logged and never sent, and this line is the whole point of the 404.
  if (collections.isErr()) {
    return responses.fromError(
      errors.notFound(undefined, `no such list type; try one of ${LIST_TYPES.join(', ')}`)
    )
  }

  const userId = await findIdOfName(username).unwrapOr(undefined)
  // A name nobody has taken and a name whose lists happen to be empty are
  // different things, and only the first is a 404.
  //
  // `message` again, and `detail` deliberately empty: the name came out of an
  // unauthenticated route's own url, so logging it would let anyone write a
  // line to the function log by asking after profiles at random. That is the
  // reason `findOneByFieldOrFail_` carries no detail either. #280.
  if (!userId) {
    return responses.fromError(errors.notFound(undefined, `no such user: ${username}`))
  }

  const limit = toLimit(event)
  const siteUrl = toSiteUrl(event)
  const context = { username, siteUrl }

  // The url the README, the `<noscript>` block and `robots.txt` all advertise
  // is this one, and what it used to answer was 4.76 MB assembled out of eight
  // queries in up to 9.5 seconds — against a 10-second function timeout, which
  // a caller sees as a dropped connection rather than as a status code. That is
  // #334. An index is what that url is actually for: it says how big each list
  // is and where it lives, in a few hundred bytes, so a reader chooses before
  // it downloads rather than after a failure. Asking for entries here is still
  // `?limit=N`, which the index names.
  if (!namesType && limit === undefined) {
    const counts = await findListCounts(collections.value, types, userId)
    const index = toExportIndex({ username, counts, siteUrl })

    return wantsMarkdown(event)
      ? asText(MARKDOWN_CONTENT_TYPE, toIndexMarkdown(index), context)
      : asJson(index, context)
  }

  const lists = await Promise.all(
    collections.value.map(async (collection, index) =>
      toExportList(types[index], await findListEntries(collection, userId, limit))
    )
  )

  const document = toExportDocument({ username, lists, siteUrl })

  return wantsMarkdown(event)
    ? withinBudget(MARKDOWN_CONTENT_TYPE, toMarkdown(document, siteUrl), context)
    : asJson(document, context)
}

export {
  exportUserLists,
}
///////////////////////////////////////////////////////////////////////////////

const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8'

/**
 * How many entries each list holds, keyed by the type the index names them
 * by. Counted by the database rather than assembled — this is the reason the
 * index is cheap, and the reason it is worth being a different document
 * rather than a truncation of the other one.
 * @type {(collections: ValidCollection[], types: string[], userId: string) => Promise<Object.<string, number>>}
 */
const findListCounts = async (collections, types, userId) => {
  const counts = await Promise.all(
    collections.map((collection) => db.countUserEntries_(collection, userId).unwrapOr(0))
  )

  return Object.fromEntries(types.map((type, index) => [type, counts[index]]))
}

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
 * @typedef {{ username: string, siteUrl?: string }} Context
 * @type {(body: object, context: Context) => Response}
 */
const asJson = (body, context) =>
  safeJSONStringify(body).match(
    (text) => withinBudget(responses.JSON_CONTENT_TYPE, text, context),
    (error) => responses.fromError(errors.internal(error))
  )

/**
 * A body over the ceiling never reaches the caller, so say what happened and
 * what to ask for instead. Both suggestions are smaller by construction: one
 * list is a quarter of four, and a limit is whatever the caller can take.
 *
 * The same urls reach a caller that has not failed yet, in the `Link` header
 * below and in the index document — #334, whose complaint was that the only
 * place this endpoint ever mentioned its own knobs was a response you had to
 * earn.
 * @type {(contentType: string, body: string, context: Context) => Response}
 */
const withinBudget = (contentType, body, { username, siteUrl }) =>
  Buffer.byteLength(body) <= MAX_BODY_BYTES
    ? asText(contentType, body, { username, siteUrl })
    : responses.payloadTooLarge({
        error: 'These lists are too big to send in one response.',
        tryInstead: [
          ...toExportUrls(username).lists.map(({ url }) => url),
          `/api/export/${username}?limit=200`,
        ],
      })

/**
 * The one response in the tree that does not come out of `responses.js`, so
 * the site-wide headers are spread in by hand here. Written as the shared
 * constant rather than as its own list: this route is the reason `nosniff` is
 * in that list at all — two content types off one path, both of them users'
 * own note text, and the CORS header below on the same response.
 * @type {(contentType: string, body: string, context: Context) => Response}
 */
const asText = (contentType, body, { username, siteUrl }) => ({
  statusCode: 200,
  headers: {
    'content-type': contentType,
    ...responses.SECURITY_HEADERS,
    // Public data, and reading it from a page or a notebook shouldn't need a
    // proxy.
    'access-control-allow-origin': '*',
    ...CACHE_HEADERS,
    link: toLinkHeader(username, siteUrl),
  },
  body,
})

/**
 * Where else to look, on every response rather than only on the one that
 * failed. A reader that has just downloaded a megabyte of games learns from
 * the headers alone that there are three more lists and an index, without
 * parsing a body or fetching anything — a `curl -I` is enough, and so is a
 * `HEAD` from a tool whose response budget the body would have blown.
 *
 * Every response carries the same set, including the index and including a
 * list linking to itself. A self link is ordinary, and one header built one
 * way is worth more than a rule about which url gets which subset.
 *
 * `index` and `section` are both IANA-registered relations and mean here what
 * they say: the index document, and the four lists it indexes.
 * @type {(username: string, siteUrl?: string) => string}
 */
const toLinkHeader = (username, siteUrl) => {
  const urls = toExportUrls(username, siteUrl)

  return [
    `<${urls.index}>; rel="index"`,
    ...urls.lists.map(({ url, title }) => `<${url}>; rel="section"; title="${title}"`),
  ].join(', ')
}
