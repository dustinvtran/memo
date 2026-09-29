/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/responses').Response} Response */
/**
 * @file Signing out everywhere: ending every session a user has, on every
 * device, at once.
 *
 * A session lasts as long as it is used (`SESSION_LIFETIME_SECONDS`), so this
 * is the way to end one early — a lost laptop, a shared computer left signed
 * in. It writes the current second to the user's `sessionsValidAfter`, and
 * `userIdOfSession` refuses every session that began at or before it, the one
 * making this request included. This browser's cookies are cleared as well,
 * so it looks signed out straight away rather than on its next request.
 *
 * API tokens are not sessions and are not touched: they are revoked one at a
 * time, from the token routes.
 */
import { errAsync, okAsync } from 'neverthrow'
import * as responses from '../utils/responses.js'
import * as errors from '../utils/errors.js'
import * as db from '../utils/db/index.js'
import { getSessionUserId } from './utils.js'
import { toPromise } from '../utils/general.js'
import { generateLogoutCookies } from './auth.js'

/**
 * Session only, like the token routes: an API token that could sign its
 * owner out everywhere would be a stranger's way to do it to them.
 *
 * An account with no user document yet — signed in, no username chosen — has
 * nowhere to write the field, and creating one here would be a user with no
 * name, which the unique index on `username` cannot hold two of.
 * @type {(event: Event, context: Context) => Promise<Response>}
 */
const signOutEverywhere = (event) => toPromise(
  getSessionUserId(event)
    .andThen((userId) => db.findOneByField_('users', 'userId', userId))
    .andThen((user) =>
      user
        ? okAsync(user)
        : errAsync(errors.conflict(
            undefined,
            'choose a username first; there is no account to sign out yet'
          ))
    )
    .andThen((user) => {
      const sessionsValidAfter = Math.floor(Date.now() / 1000)
      return db.updateByRef_('users', user._id, { sessionsValidAfter })
        .map(() => sessionsValidAfter)
    })
    .map((sessionsValidAfter) => ({
      ...responses.ok({ sessionsValidAfter }),
      multiValueHeaders: { 'Set-Cookie': generateLogoutCookies() },
    }))
    .mapErr(responses.fromError)
)

export { signOutEverywhere }
