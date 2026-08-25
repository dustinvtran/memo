/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('../utils/parsers').ValidCollection} ValidCollection */
/** @typedef {import('../utils/errors').Error} Error */
/** @typedef {import('../utils/responses').Response} Response */
import * as responses from '../utils/responses.js'
import { ResultAsync } from 'neverthrow'
import { getUserId, getReqBody } from './utils.js'
import { pair, toAsync, toPromise } from '../utils/general.js'
import * as db from '../utils/db/index.js'
import { biography as parseBiography } from '../utils/parsers/users.js'
/** @type {(event: Event, context: Context) => Promise<Response>} */
const setBio = (event) => toPromise(
  ResultAsync.combine(pair([
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
        // rather than the 502 that destructuring the db module's miss used
        // to give. See #139.
        .andThen((bio) =>
          db.findOneByFieldOrFail_('users', 'userId', uid)
            .map((user) => [user._id, bio])
        )
    )
    .andThen(([userRef, newBio]) =>
      db.updateByRef_('users', userRef, { biography: newBio })
    )
    .map(responses.ok)
    .mapErr(responses.fromError)
)


export {
  setBio,
}