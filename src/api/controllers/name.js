/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/errors').Error} Error */
const { combine, okAsync, ResultAsync } = require('neverthrow')
const { findOneByField_, findOneByField, updateByRef_, create_ } = require('../utils/db')
const { pair, toPromise } = require('../utils/general')
const responses = require('../utils/responses')
const { getUserId, getReqBody, getSegment } = require('./utils')
const feErrors = require('../utils/frontend_errors')

/** @type {(event: Event) => Promise<Response>} */
const findOwnName = (event) => toPromise(
  getUserId(event)
    .asyncAndThen((userId) => findOneByField_('users', 'userId', userId))
    .map(({ data }) => data
      ? responses.ok({ username: data.username })
      : responses.ok(feErrors.noUsernameSet())
    )
    .mapErr(() => responses.ok({}))
)

/** @type {(event: Event) => Promise<Response>} */
const getUserIdFromName = (event) =>
  findOneByField('users', 'username', getSegment(0, event))

/** @type {(event: Event) => Promise<Response>} */
const setOwnName = (event) => toPromise(
  combine(pair([
    getUserId(event),
    getReqBody(event)
  ]))
    .asyncAndThen(assignNameIfNotTaken)
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
  findOneByField_('users', 'username', newName)
    .andThen(({ data }) => data
        ? okAsync(responses.ok(feErrors.nameTaken(newName)))
        : assignName(userId, newName).map(() => responses.ok())
    )

/** @type {(userId: string, newName: string) => ResultAsync<any, Error>} */
const assignName = (userId, newName) =>
  findOneByField_('users', 'userId', userId)
    .andThen(({ ref }) => ref
      ? updateByRef_('users', ref.id, { username: newName })
      : create_('users', { userId, username: newName })
    )
