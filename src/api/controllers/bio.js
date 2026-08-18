/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const { combine } = require('neverthrow')
const { getUserId, getReqBody } = require('./utils')
const { pair, toPromise } = require('../utils/general')
const db = require('../utils/db/')

/** @type {(event: Event, context: Context) => Promise<Response>} */
const setBio = (event) => toPromise(
  combine(pair([
    getUserId(event),
    getReqBody(event)
  ]))
    // A valid token for a `sub` with no user document — which is every account
    // between signing up and `setOwnName` running — is a 404 rather than the
    // 502 that destructuring the db module's `{}` used to give. See #139.
    .asyncAndThen(([uid, { newBio }]) =>
      db.findOneByFieldOrFail_('users', 'userId', uid)
        .map(({ ref }) => [ref, newBio])
    )
    .andThen(([ref, newBio]) =>
      db.updateByRef_('users', ref.id, { biography: newBio })
    )
    .map(responses.ok)
    .mapErr(responses.fromError)
)


module.exports = {
  setBio,
}
