/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').BookRetrieveFunction} BookRetrieveFunction */
/** @typedef {import('../../errors').Error} Error */
/** @typedef {import('../../parsers/books').Book} Book */
import { ResultAsync } from 'neverthrow'
import * as errors from '../../errors.js'
import axios from 'axios'
import { throwIt } from '../../general.js'
import { retrying, describeFailure, publicFailure, statusOf } from '../retry.js'
import { BASE_URL, searchUrls, toSearchResults } from './google_search.js'
const { GOOGLE_API_KEY } = process.env

/* Only use key if it's present in the env vars */
const urlKey =
  GOOGLE_API_KEY
    ? `&key=${GOOGLE_API_KEY}`
    : ''

/**
 * A search is several requests now — see ./google_search.js for which, and
 * why one of them wasn't enough.
 * @type SearchFunction
 */
const search = (titleSearch) => ResultAsync.fromPromise(
  searchPages(searchUrls(titleSearch, urlKey))
    .then((pages) => toSearchResults(titleSearch, pages)),
  toError('searching for books')
)

/** @type BookRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  retrying(() => axios({
    method: 'get',
    url: `${BASE_URL}?q=isbn:${ref}${urlKey}`
  }))
    .then(({ data }) => volumesOf(data).map(({ volumeInfo }) => ({
      entryType: 'Book',
      publishers: volumeInfo.publisher ? [volumeInfo.publisher] : undefined,
      englishTranslatedTitle: volumeInfo.title,
      releaseYear: parseInt(volumeInfo.publishedDate?.substring(0, 4)) || undefined,
      duration: volumeInfo.pageCount,
      imageUrl: volumeInfo?.imageLinks?.thumbnail,
      authors: volumeInfo?.authors,
      apiRefs: [`ISBN__${ref}`],
      externalUrls: volumeInfo?.canonicalVolumeLink
        ? [{ name: 'Google Play', url: volumeInfo?.canonicalVolumeLink }]
        : [],
    }))[0] ?? throwNoSuchVolume(ref)),
  toError('retrieving a book')
)

/** @type Adapter */
export {
  search,
  retrieve
}
///////////////////////////////////////////////////////////////////////////////

/**
 * Google omits `items` entirely when nothing matched, rather than sending an
 * empty array. Reading it as one was a TypeError, and a search with no hits
 * came back a 500 instead of "No results found for this query...".
 * @type {(data: any) => any[]}
 */
const volumesOf = (data) => data?.items ?? []

/**
 * The volumes on each of `urls`, requested together.
 *
 * A page Google wouldn't answer comes back empty rather than failing the
 * search: it answers something like one search in eight with a 503 (see
 * ../retry.js), and four requests where there used to be one is four chances
 * of that. Fewer results is a better answer than none, and `retrying` has
 * already given the page its three attempts by the time we get here.
 *
 * If *every* page failed there is nothing to show, so the first failure goes
 * on to `toError` the way a single failed request always did.
 * @type {(urls: string[]) => Promise<any[][]>}
 */
const searchPages = (urls) => Promise.all(
  urls.map((url) =>
    retrying(() => axios({ method: 'get', url }))
      .then(({ data }) => ({ volumes: volumesOf(data) }))
      .catch((err) => ({ err }))
  )
).then((pages) =>
  pages.some((page) => page.volumes)
    ? pages.map((page) => page.volumes ?? [])
    : throwIt(pages[0].err)
)

/** @type {(ref: string) => never} */
const throwNoSuchVolume = (ref) => {
  throw Object.assign(
    new Error(`Google Books holds no volume under ISBN ${ref}.`),
    { status: 404 },
  )
}

/**
 * Google Books answers a fair share of requests with a 503, so a failure that
 * gets this far has already been retried and is worth logging with the status
 * that caused it — the message that used to reach the user said only that
 * there was a "problem".
 *
 * The whole of it goes to the log and only the class of failure to the
 * caller, who is owed enough to know whether to try again and nothing about
 * how this is wired up. #105.
 * @type {(doing: string) => (err: any) => Error}
 */
const toError = (doing) => (err) =>
  statusOf(err) === 404
    ? errors.notFound(
        `Google Books has no such book (${doing}): ${describeFailure(err)}`,
        'no such book',
      )
    : errors.internal(
        `Google Books failed while ${doing}: ${describeFailure(err)}`,
        publicFailure('Google Books', err),
      )
