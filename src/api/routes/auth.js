/** @typedef {import('@netlify/functions').Handler} Handler */
const responses = require('../utils/responses')
const { matchVerbAndNumberOfUrlSegments, } = require('../router')
const { getUrlSegments } = require('../controllers/utils')
const { handleLogout, handleLogin, handleCallback, handleRenew } = require('../controllers/auth')
const { match } = require('ts-pattern')

/** @type Handler */
exports.handler = async (event, context) => {
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
