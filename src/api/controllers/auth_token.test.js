/**
 * @file The session token, against the real `jose` rather than a stand-in.
 *
 * Every other controller test replaces `jose` with something that takes the
 * token at its word, because none of them is about the token. This one is,
 * and it exists because nothing was: `getUserId` used to *throw* on a token
 * that failed to verify rather than answer `Err`, which reached the caller
 * as a 502, and an expired session is the ordinary way to arrive there.
 *
 * It needs the dependencies, so it **skips itself** when they aren't
 * installed — which is how CI runs the suite.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const dependenciesInstalled = (() => {
  try {
    require('jose')
    require('neverthrow')
    require('ramda')
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

const jose = dependenciesInstalled ? require('jose') : undefined
const { getUserId } = dependenciesInstalled ? require('./utils') : {}

const secret = () => new TextEncoder().encode(process.env.TOKEN_SECRET)

/** A token shaped like the one `signNetlifyJWT` mints. */
const sign = ({ sub = 'auth0|somebody', exp, key = secret() } = {}) => {
  const iat = Math.floor(Date.now() / 1000)
  return new jose.SignJWT({
    exp: exp ?? iat + 14 * 24 * 3600,
    iat,
    updated_at: iat,
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
