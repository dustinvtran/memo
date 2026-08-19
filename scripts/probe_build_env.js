/**
 * @file THROWAWAY, like `src/api/routes/runtime_probe.js`. Deleted before this
 * PR leaves draft — see #185 and #190.
 *
 * The probe function reports what the *runtime* sees. This reports what the
 * *build* sees, which is the other half of the question: a check can only fail
 * a deploy over `AWS_LAMBDA_JS_RUNTIME` if the build is given it. UI variables
 * are scoped, and a variable scoped to functions alone would be invisible here
 * while still pinning the runtime.
 *
 * Netlify build logs are not readable from a laptop, so this writes its answer
 * where the deploy will serve it: `_redirects` sends `/js/*` to itself with a
 * forced rule, so a file under `dist/js` is one of the few things that comes
 * back as itself rather than as the homepage's HTML.
 *
 * Named keys only — never the environment wholesale. `MONGODB_URL` and four
 * API keys are in it.
 */
const fs = require('node:fs')
const path = require('node:path')

const REPORT = path.join('dist', 'js', 'build_env.json')

const report = {
  'process.version': process.version,
  AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME ?? null,
  NODE_VERSION: process.env.NODE_VERSION ?? null,
  NETLIFY: process.env.NETLIFY ?? null,
  CONTEXT: process.env.CONTEXT ?? null,
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)
console.log(`wrote ${REPORT}\n${JSON.stringify(report, null, 2)}`)
