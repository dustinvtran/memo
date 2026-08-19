/**
 * @file THROWAWAY. Delete before this PR leaves draft — see #185.
 *
 * The rule in CLAUDE.md — nothing `src/api/routes/**` can reach may be an ES
 * module — rests on a symptom with no diagnosis. This reports what the
 * deployed functions runtime actually is, so that what to do about it stops
 * being weighed against a guess.
 *
 * Deliberately depends on nothing else in this repo: a probe that 502s for an
 * unrelated reason answers nothing.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** @type {(fn: () => any) => { ok: boolean, code?: string, message?: string }} */
const attempt = (fn) => {
  try {
    fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, code: e?.code ?? null, message: e?.message?.split('\n')[0] }
  }
}

/** @type {(fn: () => Promise<any>) => Promise<{ ok: boolean, code?: string, message?: string }>} */
const attemptAsync = async (fn) => {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, code: e?.code ?? null, message: e?.message?.split('\n')[0] }
  }
}

/**
 * A `.mjs` written at request time is an ES module whatever the surrounding
 * `package.json` says, and it cannot go missing the way a traced dependency
 * can — so a `MODULE_NOT_FOUND` from the package below stays distinguishable
 * from the `ERR_REQUIRE_ESM` this is looking for.
 */
const esmFile = path.join(os.tmpdir(), `probe_${process.pid}.mjs`)
const wroteEsmFile = attempt(() =>
  fs.writeFileSync(esmFile, 'export const loaded = true\n'))

exports.handler = async (event, context) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    version: process.version,
    'features.require_module': process.features.require_module,
    execArgv: process.execArgv,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV ?? null,
    AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME ?? null,

    // The rule, tested two ways. `escape-string-regexp` 5 is ESM-only and
    // already in the production dependency tree (Eleventy pulls it in), 4KB
    // with no dependencies of its own. Both specifiers are written out in
    // full because Netlify's bundler traces literals, not variables.
    "require('escape-string-regexp')":
      attempt(() => require('escape-string-regexp')),
    'require(a .mjs written to os.tmpdir())': wroteEsmFile.ok
      ? attempt(() => require(esmFile))
      : { ok: false, code: 'the file could not be written', ...wroteEsmFile },

    // Route 1's premise: `import()` is not `require` and is unaffected by
    // `--no-experimental-require-module`, so it should load the same package
    // the line above cannot.
    "import('escape-string-regexp')":
      await attemptAsync(() => import('escape-string-regexp')),
  }, null, 2),
})
