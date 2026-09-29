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
import { findOneByFieldOrFail_ } from '../utils/db/index.js'
import * as responses from '../utils/responses.js'
import { toPromise } from '../utils/general.js'
import { getSegment } from './utils.js'
/**
 * GET /api/user/:username
 *
 * A name nobody has taken is a 404, as it is on the entries route since #253.
 * It used to answer 200 with an empty body, so a user with no biography and
 * no user at all differed only in whether `data` was there. #477.
 *
 * The `data` wrapper is the wire contract rather than a shape the db module
 * hands over — the profile page reads `resp.data`, and a bundle cached before
 * this change still does. See name.js for the same on the other probe.
 * @type {(event: Event) => Promise<Response>}
 */
const getUserFromName = (event) => toPromise(
  findOneByFieldOrFail_('users', 'username', getSegment(0, event))
    .map((user) => ({
      data: { username: user.username, biography: user.biography },
    }))
    .map(responses.ok)
    .mapErr(responses.fromError)
)

export {
  getUserFromName,
}