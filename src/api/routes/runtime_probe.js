/**
 * @file THROWAWAY. Delete before this PR leaves draft — see #185 and #190.
 *
 * This branch removes the AWS_LAMBDA_JS_RUNTIME override and lets the
 * functions inherit NODE_VERSION, which is what Netlify documents and what
 * makes one number in netlify.toml the whole configuration. The documentation
 * is not the same thing as this site doing it, and a claim about this setting
 * has been wrong once already, so it gets read off a deploy preview:
 * `<deploy-preview-url>/api/runtime_probe`.
 *
 * The number to look at is `AWS_EXECUTION_ENV`. Netlify substitutes Node 24
 * for a build version it cannot map to a Lambda runtime, silently, so
 * `AWS_Lambda_nodejs24.x` here would mean the inheritance worked and the ask
 * did not.
 *
 * Deliberately depends on nothing else in this repo: a probe that 502s for an
 * unrelated reason answers nothing.
 */
exports.handler = async (event, context) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV ?? null,
    version: process.version,
    // Null is the answer this branch wants: the override is gone.
    AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME ?? null,
    // #185's finding, cheap to re-read on a runtime this repo has not run on
    // before: AWS passes --no-experimental-require-module on the command line,
    // so this stays false however new the runtime is.
    'features.require_module': String(process.features.require_module),
    execArgv: process.execArgv,
  }, null, 2),
})
