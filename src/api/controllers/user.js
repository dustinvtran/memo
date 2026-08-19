/**
 * @file The public half of a user document.
 *
 * The profile page wants a name and a biography. The document also holds
 * `userId` — the auth0 `sub` every ownership check is written against — and
 * a stats blob, and answering with the whole thing published the first to
 * anyone who asked for a profile. Ownership is settled against a verified
 * JWT rather than against this value, so it was never a way in; it was an
 * internal identifier handed out for no reason. See #105.
 */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/errors').Error} Error */
const { findOneByField_ } = require('../utils/db')
const responses = require('../utils/responses')
const { toPromise } = require('../utils/general')
const { getSegment } = require('./utils')

/**
 * GET /api/user/:username
 *
 * A name nobody has taken still answers 200 with an empty body, which is what
 * the profile page turns into its own 404.
 *
 * The `data` wrapper is the wire contract rather than a shape the db module
 * hands over — the profile page reads `resp.data`, and a bundle cached before
 * this change still does. See name.js for the same on the other probe.
 * @type {(event: Event) => Promise<Response>}
 */
const getUserFromName = (event) => toPromise(
  findOneByField_('users', 'username', getSegment(0, event))
    .map((user) => user
      ? { data: { username: user.username, biography: user.biography } }
      : {}
    )
    .map(responses.ok)
    .mapErr(responses.fromError)
)

module.exports = {
  getUserFromName,
}
