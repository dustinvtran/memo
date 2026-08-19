/**
 * @file This file exports simple Netlify HTTP Response constructors
 * that also safely convert Response body to JSON string.
 */
/** @typedef {import('./errors').Error} Error */
const { match } = require('ts-pattern')
const { safeJSONStringify, warn } = require('./general')

/** @typedef {{ statusCode: number, headers?: Object.<string, string>, body?: any }} Response */

/** @typedef {(body?: any) => Response} ResponseCreator */

/**
 * Everything built here is JSON. Without a content type Netlify serves it as
 * `text/plain`, and a reader deciding how to parse a body deserves to be told.
 */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * What the caller is told when the error carries no message of its own: the
 * class of failure and not one word more. The driver's own account of it —
 * the hosts it tried, the topology it gave up on, the stack — is what #105 is
 * about, and it goes to the log in `fromError` instead.
 */
const STOCK_MESSAGES = {
  DBError: 'the database did not answer',
  RequestError: 'the request could not be read',
  UnauthorizedError: 'not authorized',
  NotFound: 'not found',
  InternalError: 'something went wrong',
}

/** @type {(statusCode: number) => ResponseCreator} */
const response = (statusCode) => (body) =>
  safeJSONStringify(body).match(
    (text) => asJson(statusCode, text),
    (err) => (warn(err), asJson(500)),
  )

/**
 * Reads are unauthenticated, so anyone can make a request fail and read what
 * comes back. Everything an error knows is logged here — this is the one
 * place an error becomes a response, so it is the one place that can promise
 * each is accounted for exactly once — and the caller gets `message` and the
 * name of the class, both of which are ours to publish.
 * @type {(error: Error) => Response}
 */
const fromError = (error) => {
  if (error?.detail) console.error(`${error.error}: ${error.detail}`)

  const body = {
    error: error?.error,
    message: error?.message
      ?? STOCK_MESSAGES[error?.error]
      ?? STOCK_MESSAGES.InternalError,
  }

  return match(error?.error)
    .with('DBError', () => response(500)(body))
    .with('RequestError', () => response(400)(body))
    .with('UnauthorizedError', () => response(401)(body))
    // A URL naming something that doesn't exist — an unknown entry type, say —
    // is the caller's mistake, not a server fault.
    .with('NotFound', () => response(404)(body))
    .with('InternalError', () => response(500)(body))
    .otherwise(() => response(500)(body))
}

/**
 * `fromError` is how a failure becomes a response. The bare constructors take
 * whatever body they are given and send it, which is fine for a body written
 * on purpose and is how an error object came to be serialised into a 500 —
 * so there is no bare 500 here to reach for.
 */
module.exports = {
  JSON_CONTENT_TYPE,
  STOCK_MESSAGES,
  ok: response(200),
  badRequest: response(400),
  unauthorized: response(401),
  notFound: response(404),
  payloadTooLarge: response(413),
  fromError,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(statusCode: number, body?: string) => Response} */
const asJson = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': JSON_CONTENT_TYPE },
  ...(body === undefined ? {} : { body }),
})
