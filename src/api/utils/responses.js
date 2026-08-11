/**
 * @file This file exports simple Netlify HTTP Response constructors
 * that also safely convert Response body to JSON string.
 */
/** @typedef {import('./errors').Error} Error */
const { match } = require('ts-pattern')
const { safeJSONStringify, warn } = require('./general')

/** @typedef {{ statusCode: number, body?: any }} Response */

/** @typedef {(body?: any) => Response} ResponseCreator */

/** @type {(statusCode: number) => ResponseCreator} */
const response = (statusCode) => (body) =>
  safeJSONStringify(body).match(
    (body) => ({ statusCode, body }),
    (err) => (warn(err), { statusCode: 500 }),
  )

/** @type {(error: Error) => Response} */
const fromError = (error) => match(error.error)
  .with('DBError', () => response(500)(error.context))
  .with('RequestError', () => response(400)(error.context))
  .with('UnauthorizedError', () => response(401)(error.context))
  // A URL naming something that doesn't exist — an unknown entry type, say —
  // is the caller's mistake, not a server fault.
  .with('NotFound', () => response(404)(error.context))
  .with('InternalError', () => response(500)(error.context))
  .otherwise(() => response(500)(error.context))

module.exports = {
  ok: response(200),
  badRequest: response(400),
  unauthorized: response(401),
  notFound: response(404),
  internalError: response(500),
  fromError,
}
