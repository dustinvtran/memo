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
 * So the dynamic import lives behind a seam a test can replace. It used to be
 * replaced by patching `Module._load` around this module's path, which worked
 * but tied the suite to a hook ES modules do not have. `useLoader` is that
 * seam made ordinary, and it is what let #185's route 3 go ahead — see
 * `docs/module_system.md`.
 */

/** @returns {Promise<typeof import('openid-client')>} */
const realLoader = () => import("openid-client")

let loader = realLoader

/** @returns {Promise<typeof import('openid-client')>} */
const load = () => loader()

/**
 * Hand this module something else to load the package from. The suite is the
 * only caller; nothing in `src/api` calls it at all.
 *
 * @type {(replacement: () => Promise<any>) => void}
 */
const useLoader = (replacement) => {
  loader = replacement
}

export { load, useLoader }
