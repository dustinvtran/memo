/** @typedef {import('../types').Adapter} Adapter */
/** @typedef {import('../types').SearchFunction} SearchFunction */
/** @typedef {import('../types').SearchResult} SearchResult */
/** @typedef {import('../types').BookRetrieveFunction} BookRetrieveFunction */
/** @typedef {import('../../errors').Error} Error */
/** @typedef {import('../../parsers/books').Book} Book */
const { ResultAsync } = require('neverthrow')
const errors = require('../../errors')
const axios = require('axios').default
const { retrying, describeFailure, statusOf } = require('../retry')

const { GOOGLE_API_KEY } = process.env

/* Only use key if it's present in the env vars */
const urlKey =
  GOOGLE_API_KEY
    ? `&key=${GOOGLE_API_KEY}`
    : ''

/** @type SearchFunction */
const search = (titleSearch) => ResultAsync.fromPromise(
  retrying(() => axios({
    method: 'get',
    url: `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(titleSearch)}&maxResults=40${urlKey}`
  }))
    .then(({ data }) => volumesOf(data)
      .filter(({ volumeInfo }) =>
        volumeInfo?.industryIdentifiers?.some((i) => i.type?.includes('ISBN'))
      )
      .map(({ volumeInfo }) => ({
        title: `${volumeInfo?.title} [${volumeInfo?.authors?.join(', ')}]`,
        year: volumeInfo?.publishedDate?.substring(0, 4),
        ref: volumeInfo?.industryIdentifiers?.find((i) => i.type?.includes('ISBN'))?.identifier,
        imageUrl: volumeInfo?.imageLinks?.thumbnail,
      }))
    ),
  toError('searching for books')
)

/** @type BookRetrieveFunction */
const retrieve = (ref) => ResultAsync.fromPromise(
  retrying(() => axios({
    method: 'get',
    url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${ref}${urlKey}`
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
module.exports = {
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
 * @type {(doing: string) => (err: any) => Error}
 */
const toError = (doing) => (err) => {
  console.error(`Google Books failed while ${doing}: ${describeFailure(err)}`)

  return statusOf(err) === 404
    ? errors.notFound('Google Books')
    : errors.internal(`Google Books failed while ${doing} (${describeFailure(err)})`)
}
