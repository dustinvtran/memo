/**
 * @file The credential in an `Authorization` header, for the two places that
 * read one: `getBearer` in `controllers/utils.js` and the renewal path in
 * `controllers/auth.js`.
 *
 * The scheme is case-insensitive (RFC 9110 §11.1), and some HTTP clients send
 * `bearer`. Matching `'Bearer '` exactly handed their token to the JWT
 * verifier with the scheme still on it, which answered 401 about a JWT nobody
 * sent. See #486.
 *
 * A header with no scheme at all is passed through as it came, which is what
 * both callers did before and what nothing has asked to change.
 *
 * Imports nothing, so the suite tests it with no install.
 */

const BEARER_SCHEME = /^bearer +/i

/** @type {(authorization: string) => string} */
const bearerCredential = (authorization) =>
  authorization.replace(BEARER_SCHEME, '')

export { bearerCredential }
