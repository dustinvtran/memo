/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/errors').Error} Error */
import { okAsync, ResultAsync } from 'neverthrow'
import { findOneByField_, updateByRef_, create_ } from '../utils/db/index.js'
import { pair, toAsync, toPromise } from '../utils/general.js'
import * as responses from '../utils/responses.js'
import { getUserId, getReqBody, getSegment } from './utils.js'
import * as feErrors from '../utils/frontend_errors.js'
import { username as parseUsername } from '../utils/parsers/users.js'
/**
 * GET /api/name
 *
 * The name of whoever is asking. An account that has not picked one yet gets
 * `NoUsernameSet` as a 200: that is a real answer to a real question, and the
 * `UsernameSetter` on the home page is drawn from it.
 *
 * Everything else is reported as what it is. This used to end
 * `.mapErr(() => responses.ok({}))`, so an expired token, a tampered one and a
 * database that did not answer all arrived as `200 {}` — which the home page
 * read as a user with no name at all and greeted as `Hi undefined!`, linking
 * to `/profile/undefined`. `isLoggedIn` on the frontend is the presence of the
 * `nf_jwt` cookie and nothing about whether it still verifies, so an expired
 * session is exactly the case that got there. See #216.
 * @type {(event: Event) => Promise<Response>}
 */
const findOwnName = (event) => toPromise(
  getUserId(event)
    .andThen((userId) => findOneByField_('users', 'userId', userId))
    .map((user) => user
      ? responses.ok({ username: user.username })
      : responses.ok(feErrors.noUsernameSet())
    )
    .mapErr(responses.fromError)
)

/**
 * GET /api/name/:username
 *
 * Whether that name is taken, and nothing else. The list page asks this
 * before it draws a list and only looks at whether an answer came back — the
 * whole user document, `userId` included, used to come back with it. See
 * #105, and user.js for the same projection on the profile route.
 *
 * The `data` wrapper is this route's wire contract, spelled out here because
 * it is no longer the shape the db module hands over: a bundle cached before
 * this change still reads `resp.data`.
 * @type {(event: Event) => Promise<Response>}
 */
const getUserIdFromName = (event) => toPromise(
  findOneByField_('users', 'username', getSegment(0, event))
    .map((user) => user ? { data: { username: user.username } } : {})
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/** @type {(event: Event) => Promise<Response>} */
const setOwnName = (event) => toPromise(
  ResultAsync.combine(pair([
    getUserId(event),
    toAsync(getReqBody(event))
  ]))
    .andThen(assignNameIfNotTaken)
    .mapErr(responses.fromError)
)

export {
  findOwnName,
  setOwnName,
  getUserIdFromName,
}
///////////////////////////////////////////////////////////////////////////////

/**
 * The write is chained rather than fired off, so the 200 means the name was
 * actually taken: a serverless container can be frozen the moment the
 * response is sent, and an unawaited write never lands.
 *
 * Two people claiming one name at the same moment still both pass this
 * check — the read and the write are separate round trips. A unique index
 * on `users.username` is what settles that; see #108.
 * @type {([userId, req]: [string, any]) => ResultAsync<Response, Error>}
 */
const assignNameIfNotTaken = ([userId, { newName }]) =>
  // Checked here rather than only on the way into the database, because the
  // rename path writes through `updateByRef_`, which parses nothing: the
  // `max(16).min(2)` alphanumeric rule in the users parser only ever ran for
  // an account claiming its first name. A name is also read back out and
  // interpolated into the profile page. See #172.
  //
  // Before the lookup as well as before the write — `{ newName: { $ne: null } }`
  // reaching `findOneByField_` is a filter, not a name.
  toAsync(parseUsername(newName))
    .andThen((name) =>
      findOneByField_('users', 'username', name)
        .andThen((taken) => taken
            ? okAsync(responses.ok(feErrors.nameTaken(name)))
            : assignName(userId, name).map(() => responses.ok())
        )
    )

/** @type {(userId: string, newName: string) => ResultAsync<any, Error>} */
const assignName = (userId, newName) =>
  findOneByField_('users', 'userId', userId)
    .andThen((user) => user
      ? updateByRef_('users', user._id, { username: newName })
      : create_('users', { userId, username: newName })
    )
