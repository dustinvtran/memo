/**
 * @file Reading the default export of a CommonJS dependency, whichever of the
 * two answers this file gets.
 *
 * `src/api/package.json` makes this subtree ES modules, so every dependency
 * here is reached across the ESM/CommonJS boundary. For most packages that is
 * invisible. For a Babel-compiled one it is not: Babel writes the export as
 * `exports.default` and marks the module `__esModule`, and there are two
 * long-standing readings of that mark.
 *
 * Node's ESM loader has never honoured it. `import x from 'pkg'` gives `x` the
 * whole `module.exports` — the `{ __esModule: true, default: … }` object —
 * and the function is at `x.default`. Bundlers used to honour it and hand over
 * the inner `default`, so the same line meant two different things depending
 * on who read it.
 *
 * esbuild resolves that by matching Node whenever the importing file is itself
 * ESM: it emits `__toESM(require('pkg'), 1)`, and the `1` is "behave the way
 * Node would". Since `{ "type": "module" }` is exactly what makes these files
 * ESM, the deployed bundle now agrees with `node --test` — but both give the
 * namespace rather than the function, and that is not what the CommonJS these
 * files were written as got. #235: `igdb(…)` became "igdb is not a function"
 * on every game search and every game retrieve, which reached the user as a
 * 500.
 *
 * So the shape is read rather than assumed. Pure and dependency-free, and
 * tested against both shapes — see ./interop.test.js.
 */

/**
 * The callable a CommonJS package means as its default export, whether the
 * import handed over the function itself or the namespace holding it.
 *
 * Anything that is neither comes back untouched, so a package that exports
 * something other than a function is not quietly turned into `undefined`.
 *
 * @type {(imported: any) => any}
 */
export const callableDefault = (imported) =>
  typeof imported === 'function' || typeof imported?.default !== 'function'
    ? imported
    : imported.default
