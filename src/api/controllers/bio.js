/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
const responses = require('../utils/responses')
const { combine } = require('neverthrow')
const { getUserId, getReqBody } = require('./utils')
const { pair, toAsync, toPromise } = require('../utils/general')
const db = require('../utils/db/')
const { biography: parseBiography } = require('../utils/parsers/users')

/** @type {(event: Event, context: Context) => Promise<Response>} */
const setBio = (event) => toPromise(
  combine(pair([
    getUserId(event),
    toAsync(getReqBody(event))
  ]))
    .andThen(([uid, { newBio }]) =>
      // Validated before the write, not just on the way into a `create_` that
      // this path never reaches: `updateByRef_` stores what it is handed, so
      // `newBio` had no bound on its length or even its type. See #172.
      toAsync(parseBiography(newBio ?? null))
        // A valid token for a `sub` with no user document — which is every
        // account between signing up and `setOwnName` running — is a 404
        // rather than the 502 that destructuring the db module's `{}` used to
        // give. See #139.
        .andThen((bio) =>
          db.findOneByFieldOrFail_('users', 'userId', uid)
            .map(({ ref }) => [ref, bio])
        )
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
