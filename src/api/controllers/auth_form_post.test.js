/**
 * @file The two pure pieces of the `openid-client` 6 migration.
 *
 * The login flow has no test coverage and cannot get any here: every
 * interesting step of it — `discovery`, `buildAuthorizationUrl`,
 * `implicitAuthentication` — needs an Auth0 tenant on the other end of the
 * wire, which is why #144 said what it said about `jose` and why this upgrade
 * still ends in a manual pass on a deploy preview.
 *
 * What is left over once those are set aside is small but not nothing, and it
 * is exactly the part the migration rewrote rather than moved: v6 reads the
 * authorization response off a URL fragment, so the `form_post` body has to be
 * turned into one. Getting that wrong does not throw — it produces a state
 * that does not match, and a login that fails at the last step for no visible
 * reason.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('jose')
    require('cookie')
    // ESM-only since v6 — see the note in `auth_cookie.test.js`.
    require.resolve('openid-client/package.json')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

const { asFormPostResponseUrl, generateEncodedStateString } =
  dependenciesInstalled ? require('./auth') : {}

const CALLBACK = 'https://nil.moe/.netlify/functions/auth/callback'

/** What `implicitAuthentication` does with the url it is handed. */
const responseParameters = (url) => new URLSearchParams(url.hash.slice(1))

test('the posted body becomes the fragment, which is all v6 reads', options, () => {
  const url = asFormPostResponseUrl(
    CALLBACK,
    'id_token=header.payload.signature&state=c29tZS1zdGF0ZQ%3D%3D'
  )
  const params = responseParameters(url)

  assert.equal(params.get('id_token'), 'header.payload.signature')
  assert.equal(params.get('state'), 'c29tZS1zdGF0ZQ==')
})

test('a base64 state survives the round trip byte for byte', options, () => {
  // `state` is base64 of a JSON blob, so it can carry `+`, `/` and `=`. Form
  // encoding and fragment parsing both read a bare `+` as a space, so the one
  // that matters is that Auth0's `%2B` is still a `+` on the way out.
  const state = 'ab+cd/ef=='
  const body = new URLSearchParams({ id_token: 't', state }).toString()

  assert.match(body, /state=ab%2Bcd/)
  assert.equal(responseParameters(asFormPostResponseUrl(CALLBACK, body)).get('state'), state)
})

test('a stray newline is not quietly trimmed off the state', options, () => {
  // The reason this goes through `URLSearchParams` rather than being assigned
  // to `url.hash` directly: the fragment setter deletes tabs and newlines, and
  // a state one byte short fails its check with nothing to show for it.
  const url = asFormPostResponseUrl(CALLBACK, 'state=trailing%0A')

  assert.equal(responseParameters(url).get('state'), 'trailing\n')
})

test('nothing but the fragment is touched', options, () => {
  // v6 ignores the origin and path, but a url that disagreed with the
  // registered redirect_uri would be a trap for the next reader of this file.
  const url = asFormPostResponseUrl(CALLBACK, 'state=x')

  assert.equal(`${url.origin}${url.pathname}`, CALLBACK)
})

test('the state carries the route back, and defaults to the root', options, () => {
  const decode = (encoded) =>
    JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))

  assert.equal(decode(generateEncodedStateString('/films', 'entropy')).route, '/films')
  assert.equal(decode(generateEncodedStateString(undefined, 'entropy')).route, '/')
  // The entropy is passed in rather than generated, because v6 deleted
  // `generators.nonce()` and its replacement is only reachable asynchronously.
  assert.equal(decode(generateEncodedStateString('/', 'entropy')).nonce, 'entropy')
})
