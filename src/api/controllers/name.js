/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/errors').Error} Error */
const { combine, okAsync, ResultAsync } = require('neverthrow')
const { findOneByField_, updateByRef_, create_ } = require('../utils/db')
const { pair, toAsync, toPromise } = require('../utils/general')
const responses = require('../utils/responses')
const { getUserId, getReqBody, getSegment } = require('./utils')
const feErrors = require('../utils/frontend_errors')
const { username: parseUsername } = require('../utils/parsers/users')

/** @type {(event: Event) => Promise<Response>} */
const findOwnName = (event) => toPromise(
  getUserId(event)
    .andThen((userId) => findOneByField_('users', 'userId', userId))
    .map(({ data }) => data
      ? responses.ok({ username: data.username })
      : responses.ok(feErrors.noUsernameSet())
    )
    .mapErr(() => responses.ok({}))
)

/**
 * GET /api/name/:username
 *
 * Whether that name is taken, and nothing else. The list page asks this
 * before it draws a list and only looks at whether an answer came back — the
 * whole user document, `userId` included, used to come back with it. See
 * #105, and user.js for the same projection on the profile route.
 * @type {(event: Event) => Promise<Response>}
 */
const getUserIdFromName = (event) => toPromise(
  findOneByField_('users', 'username', getSegment(0, event))
    .map(({ data }) => data ? { data: { username: data.username } } : {})
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/** @type {(event: Event) => Promise<Response>} */
const setOwnName = (event) => toPromise(
  combine(pair([
    getUserId(event),
    toAsync(getReqBody(event))
  ]))
    .andThen(assignNameIfNotTaken)
    .mapErr(responses.fromError)
)

module.exports = {
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
        .andThen(({ data }) => data
            ? okAsync(responses.ok(feErrors.nameTaken(name)))
            : assignName(userId, name).map(() => responses.ok())
        )
    )

/** @type {(userId: string, newName: string) => ResultAsync<any, Error>} */
const assignName = (userId, newName) =>
  findOneByField_('users', 'userId', userId)
    .andThen(({ ref }) => ref
      ? updateByRef_('users', ref.id, { username: newName })
      : create_('users', { userId, username: newName })
    )
