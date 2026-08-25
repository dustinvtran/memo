/**
 * @file Real session tokens for the controller tests.
 *
 * These tests used to hand a controller a "token" that was just a user id,
 * by replacing `jose` wholesale through `Module._load`. That patch was the
 * single reason the suite could not move to ES modules, which have no such
 * hook — `docs/module_system.md` is the argument. It was also buying very
 * little: a stub that answers `{ payload: { sub: token } }` to anything
 * asserts nothing about the verification every authenticated request
 * actually depends on.
 *
 * So the tokens are real now, signed with the key the controllers verify
 * against. `auth_token.test.js` has always done it this way; the rest of the
 * controller tests were the odd ones out.
 *
 * Not named `*.test.js`, so `node --test` does not try to run it.
 */
import { SignJWT } from 'jose'
/*
 * Signed with whatever the test file put in `TOKEN_SECRET`, which is also
 * what the controllers verify against. `session_token.js` refuses a key of
 * no bytes — #193 — and that is exactly the kind of thing a stubbed `jose`
 * used to hide.
 */
const secret = () => new TextEncoder().encode(process.env.TOKEN_SECRET)

/**
 * A token for `sub`, signed the way `signNetlifyJWT` signs one.
 *
 * The literal `'expired'` mints a token that expired an hour ago rather than
 * one for a user of that name, because "a token that does not verify" is a
 * case the routes have to answer 401 to rather than 502 — see #168, and
 * #139 for the same shape one layer down.
 *
 * @type {(sub: string) => Promise<string>}
 */
const tokenFor = async (sub) => {
  const now = Math.floor(Date.now() / 1000)
  const expired = sub === 'expired'

  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(expired ? now - 7200 : now)
    .setExpirationTime(expired ? now - 3600 : now + 3600)
    .sign(secret())
}

export { tokenFor }
