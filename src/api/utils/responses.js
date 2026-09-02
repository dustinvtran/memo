/**
 * @file This file exports simple Netlify HTTP Response constructors
 * that also safely convert Response body to JSON string.
 */
/** @typedef {import('./errors').Error} Error */
import { match } from 'ts-pattern'
import { safeJSONStringify, warn } from './general.js'
/** @typedef {{ statusCode: number, headers?: Object.<string, string>, body?: any }} Response */

/** @typedef {(body?: any) => Response} ResponseCreator */

/**
 * Everything built here is JSON. Without a content type Netlify serves it as
 * `text/plain`, and a reader deciding how to parse a body deserves to be told.
 */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * The site-wide security headers, sent from here because `_headers` cannot
 * reach this far: its `/*` rules are applied to pages and static assets, and
 * a function's response headers are the function's own. Every `/api/*`
 * response carried none of these until #300 — `_headers`' note on `/api/*`
 * had already named this file as where they would have to go.
 *
 * One constant rather than a list per call site, because `export.js`'s
 * `asText` builds its own response object and needs the same set: two lists
 * that have to agree is the shape this is avoiding.
 *
 * `nosniff` is the one with a route to abuse behind it, and the export route
 * is why. `/api/export/:type/:username` answers `application/json` normally
 * and `text/markdown` with `?format=md`, both built out of users' own note
 * text — arbitrary Markdown its owner typed — and the same response carries
 * `access-control-allow-origin: *`, so anyone can point a page at it. Without
 * this header a browser is free to sniff such a body and decide it is HTML.
 *
 * `Strict-Transport-Security` is `_headers`' rule verbatim. Netlify sends the
 * API its own default of a bare `max-age=31536000`, so the one security
 * header these responses did carry was the weaker of the two, differing from
 * the rest of the same origin by nothing but the path asked for.
 *
 * No CSP, deliberately. A policy governs what a *document* may load and run,
 * and none of these bodies is a document; the one way a JSON or Markdown body
 * becomes one is content sniffing, which is what the header above now closes.
 * The site's policy is also about a specific thing — keeping a script that
 * isn't ours off a page that can read `nf_jwt` out of `document.cookie` (#173)
 * — and no part of that applies to a response that loads nothing and renders
 * nowhere. A second policy here would be a second list to keep in step with
 * `_headers` in exchange for that.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

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
const ok = response(200)
const badRequest = response(400)
const unauthorized = response(401)
const notFound = response(404)
const payloadTooLarge = response(413)

export {
  JSON_CONTENT_TYPE,
  SECURITY_HEADERS,
  STOCK_MESSAGES,
  ok,
  badRequest,
  unauthorized,
  notFound,
  payloadTooLarge,
  fromError,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(statusCode: number, body?: string) => Response} */
const asJson = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': JSON_CONTENT_TYPE, ...SECURITY_HEADERS },
  ...(body === undefined ? {} : { body }),
})
