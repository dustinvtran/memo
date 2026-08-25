/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
import { getUrlSegments } from '../controllers/utils.js'
import { handleLogout, handleLogin, handleCallback, handleRenew } from '../controllers/auth.js'
import { match } from 'ts-pattern'
/** @type Handler */
export const handler = async (event, context) => {
  return matchVerbAndNumberOfUrlSegments(event)

    // GET /api/auth/{logout | login | renew}
    .with(['GET', 1], () =>
      match(getUrlSegments(event)[0])
        .with('logout', () => handleLogout())
        .with('login', () => handleLogin(event))
        .with('renew', () => handleRenew(event))
        .otherwise(responses.notFound)
    )

    // POST /api/auth/callback
    .with(['POST', 1], () =>
      match(getUrlSegments(event)[0])
        .with('callback', () => handleCallback(event))
        .otherwise(responses.notFound)
    )

    .otherwise(() => responses.badRequest())
}
