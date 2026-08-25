/**
 * @file The one place `openid-client` is reached from.
 *
 * The package is ESM-only from v6, so it can only be loaded with `import()`.
 * That is fine for the loader — esbuild inlines it for the deployed function,
 * and the unbundled source stays loadable for `node --test` — but it is not
 * fine for the suite: every stand-in in these tests works by monkey-patching
 * `Module._load`, and `import()` does not go through `Module._load`. A test
 * that stubs `'openid-client'` that way is quietly ignored, and the handler
 * goes out to the real Auth0 instead, which is a DNS error rather than a
 * failed assertion.
 *
 * So the dynamic import lives behind a CommonJS seam that a test *can*
 * replace. This is the same trade CLAUDE.md describes for moving the
 * functions to ES modules wholesale (#185's route 3) — the harness is what
 * makes it expensive — kept to one module instead of seventy-seven.
 */

/** @returns {Promise<typeof import('openid-client')>} */
const load = () => import("openid-client")

module.exports = { load }
