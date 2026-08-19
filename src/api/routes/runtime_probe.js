/**
 * @file THROWAWAY. Delete before this PR leaves draft — see #185 and #190.
 *
 * #190 could say what the functions runtime *is* only by deploying something
 * like this, and then deleted it, which leaves the repo exactly as unable to
 * answer the question as it was before. This one asks the next question:
 * whether the runtime follows `NODE_VERSION` from `netlify.toml` when
 * `AWS_LAMBDA_JS_RUNTIME` is not set in the Netlify UI. Netlify's docs say it
 * does, and a claim about this setting has already been misleading once.
 *
 * Read it at `<deploy-preview-url>/api/runtime_probe`.
 *
 * Deliberately depends on nothing else in this repo: a probe that 502s for an
 * unrelated reason answers nothing.
 */
exports.handler = async (event, context) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    // The answer. `AWS_EXECUTION_ENV` is the runtime AWS says it started —
    // `AWS_Lambda_nodejs26.x` — and `process.version` is the Node inside it.
    // Both, because the mapping between them is what is being tested.
    version: process.version,
    AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV ?? null,

    // Whether the UI variable is still set, and whether it reaches the
    // function at all. A null here while the runtime is still pinned would
    // mean the deletion had not taken effect rather than that it had.
    AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME ?? null,

    // Whether `[build.environment]` in `netlify.toml` reaches the runtime as
    // well as the build. If it does, the runtime can be asserted from inside
    // a function; if it does not, only the build can compare the two.
    NODE_VERSION: process.env.NODE_VERSION ?? null,

    // #185's finding, cheap to re-read while we are here: AWS passes
    // `--no-experimental-require-module` on the command line, so this stays
    // false however new the runtime is.
    'features.require_module': String(process.features.require_module),
    execArgv: process.execArgv,
  }, null, 2),
})
