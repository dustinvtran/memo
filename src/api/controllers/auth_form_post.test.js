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
 * The same goes for the route the login ends on. It is a `Referer` header
 * that has been through the browser twice, so where it may point is a
 * decision rather than a detail (#229), and `readLoginCookie` is where that
 * decision is made — reachable here, unlike everything around it.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('jose')
    await import('cookie')
    // ESM-only since v6 — see the note in `auth_cookie.test.js`.
    await import('openid-client')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

/* Set before anything is asserted about a route, because it is the origin
   `toSafeRoute` compares against. Netlify sets it in every context. */
process.env.URL = 'https://nil.moe'

// The `Cookie` request header half of `cookie` 2 — a browser sending one back,
// rather than a `Set-Cookie` going out. See the note in `auth.js`.
const { stringifyCookie } = dependenciesInstalled ? await import('cookie') : {}
const { asFormPostResponseUrl, generateEncodedStateString, readLoginCookie } =
  dependenciesInstalled ? await import('./auth.js') : {}

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

/** The cookie a browser sends back mid-login, for a login begun on `referer`. */
const loginBegunOn = (referer) =>
  stringifyCookie({
    auth0_login_cookie: JSON.stringify({
      nonce: 'a-nonce',
      state: generateEncodedStateString(referer, 'entropy'),
    }),
  })

/** Where the 302 at the end of that login would send the browser. */
const landsOn = (referer) => readLoginCookie(loginBegunOn(referer)).route

test('a referer on another origin is not where a login ends', options, () => {
  // The whole of #229: any page on the internet can link to /api/auth/login,
  // and the browser hands us that page's url as the Referer. Honouring it
  // finishes a genuine login on a trusted domain by dropping the user on the
  // attacker's page, which is the setup for phishing them there.
  assert.equal(landsOn('https://evil.example/looks-like-memo'), '/')
  // A prefix of our origin is not our origin, however much it reads like one.
  assert.equal(landsOn('https://nil.moe.evil.example/films'), '/')
})

test('a protocol-relative referer is another origin too', options, () => {
  // The case a `startsWith("/")` check waves through: this is a path by that
  // test and another host once resolved. Comparing resolved origins is what
  // makes it fail, which is why it is done that way round.
  assert.equal(landsOn('//evil.example/x'), '/')
})

test('a referer of ours keeps its path, query and fragment', options, () => {
  // Why the route is carried at all: a login begun from a filtered list comes
  // back to that list rather than to the home page. What comes back is
  // relative, so nothing here can point off-site later.
  assert.equal(landsOn('https://nil.moe/films?sort=year#top'), '/films?sort=year#top')
  assert.equal(landsOn('/games?played=yes'), '/games?played=yes')
})

test('a login with no referer, or an unreadable one, ends at the home page', options, () => {
  // `generateEncodedStateString` defaults an absent referer; this pins that the
  // default survives the constraint rather than being refused by it. A route
  // that will not parse is the same answer, not a throw out of the callback.
  assert.equal(landsOn(undefined), '/')
  assert.equal(landsOn(''), '/')
  assert.equal(landsOn('http://'), '/')
})
