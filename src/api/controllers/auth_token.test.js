/**
 * @file The session token, against the real `jose` rather than a stand-in.
 *
 * Every other controller test replaces `jose` with something that takes the
 * token at its word, because none of them is about the token. This one is,
 * and it exists because nothing was: `getUserId` used to *throw* on a token
 * that failed to verify rather than answer `Err`, which reached the caller
 * as a 502, and an expired session is the ordinary way to arrive there.
 *
 * It covers the whole life of one now — `handleCallback` minting it,
 * `handleRenew` re-issuing it and `getUserId` reading it — because the rule
 * this file is mostly about, that a session may slide but not for ever, is
 * only true if all three agree on it.
 *
 * Most of it needs the dependencies, so those tests **skip themselves** when
 * they aren't installed, which is how CI runs the suite. The rules in
 * `utils/session_token.js` need nothing, so those tests always run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
const dependenciesInstalled = await (async () => {
  try {
    await import('jose')
    await import('neverthrow')
    await import('ramda')
    // `controllers/auth.js` reaches these two, and its handlers are tested here.
    await import('cookie')
    /* ESM-only since v6, so `require` of it would answer "not installed" on any
       loader without `require(esm)` and skip this file rather than fail it. */
    await import('openid-client')
    return true
  } catch (error) {
    return false
  }
})()

const options = {
  skip: dependenciesInstalled ? false : 'run `npm install` to run these',
}

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'a-secret-for-the-tests'
process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://in-memory'

process.env.URL = 'https://memo.test'
process.env.AUTH0_TOKEN_NAMESPACE = 'https://memo.test'

/* The only stand-in in the file, and it stands in for Auth0 rather than for
   anything about the token: `handleCallback` is where a session's start is
   minted rather than carried forward, so it is worth reaching, and the only
   thing between here and it is a discovery request and the response check. The
   token that comes out the other end is verified below by the real jose,
   exactly as a request to the API would verify it. */
const auth0Claims = {
  aud: 'a-client-id',
  sub: 'auth0|somebody',
  'https://memo.test/roles': ['user'],
}

/* The stub goes in through `utils/openid_client`'s own seam. That module
   exists because `openid-client` is ESM-only from v6 and can only be loaded
   with `import()`, which no amount of `Module._load` patching reaches; the
   seam used to be replaced by patching this module's path instead, which
   worked and tied the suite to a hook ES modules do not have. See
   `docs/module_system.md`.

   The shape is v6's: `discovery` answers a `Configuration` that the flow only
   passes back in, and `implicitAuthentication` answers the ID Token claims set
   directly, where v5's `callback()` answered a TokenSet with a `.claims()`. */
const { useLoader } = dependenciesInstalled
  ? await import('../utils/openid_client.js')
  : {}

if (dependenciesInstalled) {
  useLoader(async () => ({
    discovery: async () => ({}),
    useIdTokenResponseType: () => {},
    None: () => ({}),
    randomNonce: () => 'a-nonce',
    randomState: () => 'a-state',
    buildAuthorizationUrl: () => new URL('https://auth0.test/authorize'),
    implicitAuthentication: async () => auth0Claims,
  }))
}

const jose = dependenciesInstalled ? await import('jose') : undefined
const cookie = dependenciesInstalled ? await import('cookie') : undefined
const { getUserId } = dependenciesInstalled ? await import('./utils.js') : {}
const { handleRenew, handleCallback } = dependenciesInstalled ? await import('./auth.js') : {}

/* The rules themselves are dependency-free, which is the point of the module. */
import * as sessionToken from '../utils/session_token.js'
const secret = () => new TextEncoder().encode(process.env.TOKEN_SECRET)
const now = () => Math.floor(Date.now() / 1000)

/**
 * A token shaped like the one `signNetlifyJWT` mints. `sessionStartedAt` is
 * left out unless asked for, so the default is a token from before that claim
 * existed.
 */
const sign = ({ sub = 'auth0|somebody', exp, sessionStartedAt, key = secret() } = {}) => {
  const iat = now()
  return new jose.SignJWT({
    exp: exp ?? iat + 14 * 24 * 3600,
    iat,
    updated_at: iat,
    ...(sessionStartedAt === undefined
      ? {}
      : { session_started_at: sessionStartedAt }),
    aud: 'memo',
    sub,
    app_metadata: { authorization: { roles: ['user'] } },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(key)
}

const asEvent = (token) => ({
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
})

const claimsOf = async (token) =>
  (await jose.jwtVerify(token, secret(), { algorithms: ['HS256'] })).payload

/** Runs `fn` with TOKEN_SECRET set to `value`, or unset when it is undefined. */
const withSecret = async (value, fn) => {
  const previous = process.env.TOKEN_SECRET
  if (value === undefined) {
    delete process.env.TOKEN_SECRET
  } else {
    process.env.TOKEN_SECRET = value
  }
  try {
    return await fn()
  } finally {
    process.env.TOKEN_SECRET = previous
  }
}

test('a valid token answers with its subject', options, async () => {
  const result = await getUserId(asEvent(await sign({ sub: 'auth0|nil' })))

  assert.equal(result.isOk(), true)
  assert.equal(result._unsafeUnwrap(), 'auth0|nil')
})

test('a token that does not verify is unauthorized, not an exception', options, async (t) => {
  // The whole point of the file. `Result.map` does not catch, so each of these
  // used to throw out of the controller and out of the handler, and Netlify
  // answered 502 — including for the expired token, which is what an ordinary
  // session becomes after a fortnight.
  const iat = Math.floor(Date.now() / 1000)
  const otherKey = new TextEncoder().encode('not the secret we sign with')

  const cases = {
    'no Authorization header': undefined,
    'not a JWT at all': 'nonsense',
    'three segments of junk': 'a.b.c',
    'signed with another key': await sign({ key: otherKey }),
    'expired an hour ago': await sign({ exp: iat - 3600 }),
  }

  for (const [name, token] of Object.entries(cases)) {
    await t.test(name, async () => {
      const result = await getUserId(asEvent(token))

      assert.equal(result.isErr(), true)
      assert.equal(result._unsafeUnwrapErr().error, 'UnauthorizedError')
    })
  }
})

test('the algorithm is ours to choose, not the token\'s', options, async () => {
  // Without `algorithms` on the way in, a token gets to nominate how it should
  // be checked. `alg: none` is the version of that with no signature at all.
  const [, payload] = (await sign()).split('.')
  const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')

  const result = await getUserId(asEvent(`${header}.${payload}.`))

  assert.equal(result.isErr(), true)
})

test('nothing the token said reaches the caller', options, async () => {
  // `detail` is for the log; `message` is what a stranger is told. An
  // unauthorized error names neither the claim that failed nor the subject.
  const result = await getUserId(asEvent(await sign({ sub: 'auth0|private-id' })))
  const expired = await getUserId(
    asEvent(await sign({ sub: 'auth0|private-id', exp: 1 }))
  )

  assert.equal(result.isOk(), true)
  assert.equal(expired._unsafeUnwrapErr().message, undefined)
  assert.equal(
    JSON.stringify(expired._unsafeUnwrapErr()).includes('auth0|private-id'),
    false,
  )
})

///////////////////////////////////////////////////////////////////////////////
// The secret it is all signed with

test('a TOKEN_SECRET that is not set is refused, not encoded to nothing', async () => {
  // `TextEncoder.prototype.encode` defaults its argument to '', so an unset
  // secret was never a missing key here — it was a zero-length one, and HS256
  // over an empty key signs and verifies consistently enough that nothing
  // looks wrong from outside while any `sub` at all can be forged.
  assert.equal(new TextEncoder().encode(undefined).length, 0)

  await withSecret(undefined, () => {
    assert.throws(() => sessionToken.tokenSecret(), /TOKEN_SECRET/)
  })
  await withSecret('', () => {
    assert.throws(() => sessionToken.tokenSecret(), /TOKEN_SECRET/)
  })

  assert.ok(sessionToken.tokenSecret().length > 0)
})

test('a token handled with no TOKEN_SECRET is a fault, not an unauthorized request', options, async () => {
  // A 401 would send the user off to log in again over something logging in
  // cannot fix, and would be indistinguishable from an expired session.
  const token = await sign()

  await withSecret(undefined, async () => {
    await assert.rejects(async () => getUserId(asEvent(token)), /TOKEN_SECRET/)
    await assert.rejects(() => handleRenew(asEvent(token)), /TOKEN_SECRET/)
  })
})

///////////////////////////////////////////////////////////////////////////////
// The absolute session lifetime

test('a session may slide, but not past the cap', () => {
  const cap = sessionToken.MAX_SESSION_SECONDS
  const at = (startedAt) => ({ session_started_at: startedAt, iat: now() })

  assert.equal(sessionToken.isWithinAbsoluteLifetime(at(now()), now()), true)
  assert.equal(
    sessionToken.isWithinAbsoluteLifetime(at(now() - cap + 60), now()),
    true,
  )
  assert.equal(
    sessionToken.isWithinAbsoluteLifetime(at(now() - cap), now()),
    false,
  )
})

test('a token from before the claim existed is read as starting when it was minted', () => {
  // The lenient reading, and the one that does not sign everybody out on
  // deploy. It stops being reachable once every live token has been renewed.
  const cap = sessionToken.MAX_SESSION_SECONDS

  assert.equal(sessionToken.sessionStartedAt({ iat: 1000 }), 1000)
  assert.equal(
    sessionToken.sessionStartedAt({ session_started_at: 7, iat: 1000 }),
    7,
  )
  assert.equal(
    sessionToken.isWithinAbsoluteLifetime({ iat: now() - 3600 }, now()),
    true,
  )
  assert.equal(
    sessionToken.isWithinAbsoluteLifetime({ iat: now() - cap }, now()),
    false,
  )
  // Claims saying nothing about when they were issued are not ours to slide.
  assert.equal(sessionToken.isWithinAbsoluteLifetime({}, now()), false)
})

///////////////////////////////////////////////////////////////////////////////
// Renewal

test('renewal slides the expiry forward but not the session start', options, async () => {
  const startedAt = now() - 40 * 24 * 3600
  const response = await handleRenew(
    asEvent(await sign({ sessionStartedAt: startedAt })),
  )

  assert.equal(response.statusCode, 200)
  const claims = await claimsOf(JSON.parse(response.body).token)
  assert.equal(claims.sub, 'auth0|somebody')
  assert.deepEqual(claims.app_metadata.authorization.roles, ['user'])
  // The window moved; the thing that bounds it did not.
  assert.ok(claims.exp > now() + 13 * 24 * 3600)
  assert.equal(claims.session_started_at, startedAt)
})

test('a session past the cap is not renewed again', options, async () => {
  // The token presented is in perfectly good order and has a fortnight left to
  // run - it is the session behind it that has gone on long enough.
  const response = await handleRenew(asEvent(await sign({
    sessionStartedAt: now() - sessionToken.MAX_SESSION_SECONDS - 1,
  })))

  assert.equal(response.statusCode, 401)
  // The cleared cookie is what stops the frontend asking again every request.
  assert.match(response.headers['Set-Cookie'], /nf_jwt=;/)
})

test('a token from before the claim existed renews, and carries a start from then on', options, async () => {
  const response = await handleRenew(asEvent(await sign()))

  assert.equal(response.statusCode, 200)
  const claims = await claimsOf(JSON.parse(response.body).token)
  assert.ok(Math.abs(claims.session_started_at - now()) < 60)
})

test('renewal needs a token of ours to renew', options, async (t) => {
  const otherKey = new TextEncoder().encode('not the secret we sign with')

  const cases = {
    'no token at all': undefined,
    'not a JWT': 'nonsense',
    'signed with another key': await sign({ key: otherKey }),
    'expired an hour ago': await sign({ exp: now() - 3600 }),
  }

  for (const [name, token] of Object.entries(cases)) {
    await t.test(name, async () => {
      assert.equal((await handleRenew(asEvent(token))).statusCode, 401)
    })
  }
})

///////////////////////////////////////////////////////////////////////////////
// Login

test('logging in mints the session start the cap is measured from', options, async () => {
  // Everything else only ever carries this claim forward, so a login that did
  // not write it would leave every session falling back to the `iat` of
  // whichever token happened to be in hand - which is reset on every renewal,
  // and is the whole bug back again with a claim in the payload to hide it.
  const state = Buffer.from(
    JSON.stringify({ route: '/films/nil', nonce: 'a-nonce' }),
  ).toString('base64')

  const response = await handleCallback({
    headers: {
      host: 'memo.test',
      cookie: cookie.serialize(
        'auth0_login_cookie',
        JSON.stringify({ nonce: 'a-nonce', state }),
      ),
    },
    body: '',
  })

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.Location, '/films/nil')

  const [netlifyCookie] = response.multiValueHeaders['Set-Cookie']
  const claims = await claimsOf(cookie.parse(netlifyCookie).nf_jwt)

  assert.equal(claims.sub, 'auth0|somebody')
  assert.deepEqual(claims.app_metadata.authorization.roles, ['user'])
  assert.equal(claims.session_started_at, claims.iat)
  assert.ok(Math.abs(claims.session_started_at - now()) < 60)
})

test('a login and the renewals after it share one session start', options, async () => {
  // The cap is only a cap if this holds: two renewals, and the start is still
  // the one the login wrote.
  const state = Buffer.from(JSON.stringify({ route: '/' })).toString('base64')
  const login = await handleCallback({
    headers: {
      host: 'memo.test',
      cookie: cookie.serialize(
        'auth0_login_cookie',
        JSON.stringify({ nonce: 'a-nonce', state }),
      ),
    },
    body: '',
  })

  let token = cookie.parse(login.multiValueHeaders['Set-Cookie'][0]).nf_jwt
  const startedAt = (await claimsOf(token)).session_started_at

  for (let i = 0; i < 2; i++) {
    const renewal = await handleRenew(asEvent(token))
    assert.equal(renewal.statusCode, 200)
    token = JSON.parse(renewal.body).token
    assert.equal((await claimsOf(token)).session_started_at, startedAt)
  }
})
