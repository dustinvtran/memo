/**
 * @file What CI and the Netlify build check about the deployed functions:
 * what runs them, and what they are allowed to require. Dependency-free on
 * purpose, like the rest of the suite.
 *
 * The two halves have the same shape. Each is a fact about production that
 * only one line of configuration decides, that nothing in the repo used to
 * assert, and that fails silently or catastrophically rather than loudly.
 *
 * ## What runs them
 *
 * `AWS_LAMBDA_JS_RUNTIME` picks the functions runtime, and Netlify reads it
 * only from its UI, CLI or API — never from `netlify.toml`. So the API ran on
 * `nodejs18.x` for years, deprecated by AWS in September 2025, while
 * `netlify.toml` pinned `NODE_VERSION = "22"`, CI pinned Node 22, and
 * CLAUDE.md said the repo was on Node 22 deliberately. All true, all about the
 * build, none of it about the runtime serving requests, and no way to find out
 * short of deploying a function that reported `process.version` — which is
 * what #185 eventually did.
 *
 * `netlify.toml` now declares the expected value as
 * `EXPECTED_AWS_LAMBDA_JS_RUNTIME`, under a name Netlify will never act on.
 * The build *is* handed the real `AWS_LAMBDA_JS_RUNTIME`, so the two can be
 * compared where it matters, and `netlify.toml` runs this before the site is
 * built: a runtime that drifts from the declaration stops shipping.
 *
 * ## What they may require
 *
 * The functions runtime is started with `--no-experimental-require-module` —
 * #185 read it straight off `process.execArgv` on the deployed runtime, on
 * `nodejs22.x` and `nodejs26.x` alike — so `require` of an ES module throws
 * while the module is being read, before any handler runs, and every route
 * 502s at once. That is #162, and #168 nearly repeated it.
 *
 * `netlify.toml` answers it by bundling with esbuild, which inlines
 * dependencies at build time so no module boundary survives to the runtime.
 * That moves what is worth guarding, and CI's old job now asks a question
 * whose answer no longer matters: it loaded each *source* file under the
 * flag, but the source still says `require('jose')` while the artefact has
 * jose inlined. An ESM-only dependency would fail that check and ship
 * perfectly well. Kept as it was, it would eventually be deleted for crying
 * wolf, and the real rule would go unguarded with it.
 *
 * Two things still bite, and they are what this checks:
 *
 *   1. Bundling has to actually be on. Everything else here rests on it, and
 *      it is one line in a file nothing else asserts.
 *   2. `external_node_modules` bypasses the bundler by design. Those packages
 *      are copied rather than inlined, so the runtime meets them directly and
 *      the original rule applies to them exactly as it always did.
 *
 * What this deliberately does not do is bundle the functions and load the
 * output. That would need `@netlify/zip-it-and-ship-it` as a dependency —
 * 357 packages, and adding it also quietly moved `zod` — to approximate an
 * artefact Netlify builds with its own copy anyway. The failure it would
 * catch beyond what is here is a bundle that builds but will not load, and
 * bundling failures are *build* failures: Netlify fails the deploy rather
 * than shipping something broken, which is the loud half of the problem.
 * Reach for it if that ever stops being true.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG = 'netlify.toml'
const CI_WORKFLOW = '.github/workflows/ci.yml'

/**
 * Read out of `netlify.toml` rather than written down again here, so this
 * checks the configuration production uses and not a copy that can drift.
 * A shape it cannot read is a failure rather than a default — checking the
 * wrong settings quietly is worse than not checking.
 */
const readConfig = () => {
  const toml = fs.readFileSync(CONFIG, 'utf8')

  const directory = toml.match(/^\s*directory\s*=\s*"([^"]+)"/m)?.[1]
  const bundler = toml.match(/^\s*node_bundler\s*=\s*"([^"]+)"/m)?.[1]
  const externalsBlock = toml.match(/^\s*external_node_modules\s*=\s*\[([^\]]*)\]/m)
  const externals = [...(externalsBlock?.[1] ?? '').matchAll(/"([^"]+)"/g)]
    .map(([, name]) => name)

  const nodeVersion = toml.match(/^\s*NODE_VERSION\s*=\s*"([^"]+)"/m)?.[1]
  const declaredRuntime =
    toml.match(/^\s*EXPECTED_AWS_LAMBDA_JS_RUNTIME\s*=\s*"([^"]+)"/m)?.[1]
  /* Anchored so that it matches the real name and not the declaration that
     ends with it — the whole guard below rests on telling those two apart. */
  const setsRuntime = /^\s*AWS_LAMBDA_JS_RUNTIME\s*=/m.test(toml)

  return { directory, bundler, externals, nodeVersion, declaredRuntime, setsRuntime }
}

/** @type {(args: string[], what: string) => string | null} The error, or null. */
const run = (args, what) => {
  try {
    execFileSync(process.execPath, args, {
      stdio: 'pipe',
      env: {
        // Loading a route reads these into strings and connects to nothing,
        // but `db.js` throws on a missing MONGODB_URL, which would fail this
        // for the wrong reason.
        MONGODB_URL: 'mongodb://localhost:27017/memo',
        TWITCH_CLIENT_ID: 'placeholder',
        TWITCH_CLIENT_SECRET: 'placeholder',
        TMDB_API_KEY: 'placeholder',
        GOOGLE_API_KEY: 'placeholder',
        ...process.env,
      },
    })
    return null
  } catch (error) {
    return String(error.stderr || error.message).trim()
  }
}

const fail = (explanation, detail) => {
  console.error(`\n${explanation}\n`)
  if (detail) console.error(`${detail}\n`)
  process.exitCode = 1
}

const { directory, bundler, externals, nodeVersion, declaredRuntime, setsRuntime } =
  readConfig()

/* An AWS_LAMBDA_JS_RUNTIME here is read by nobody and believed by everybody,
   which is the exact shape of #185. The declaration is named so that it cannot
   be mistaken for the real setting; this is what stops someone tidying the
   name and leaving the check comparing the declaration with itself. */
if (setsRuntime) {
  fail(
    `${CONFIG} assigns AWS_LAMBDA_JS_RUNTIME, which Netlify reads only from ` +
    'its UI, CLI or API.\nSet there it picks the functions runtime; set here ' +
    'it does nothing at all except look\nlike it does — which is how the API ' +
    'spent years on nodejs18.x while every file in the\nrepo said Node 22 ' +
    '(#185). Declare the expected value as EXPECTED_AWS_LAMBDA_JS_RUNTIME ' +
    'and\nset the real one in the Netlify UI.')
}

const declaredMajor = declaredRuntime?.match(/^nodejs(\d+)\.x$/)?.[1]

if (!declaredMajor) {
  fail(
    `${CONFIG} must declare EXPECTED_AWS_LAMBDA_JS_RUNTIME as "nodejsNN.x", ` +
    `and declares\n${declaredRuntime ? `"${declaredRuntime}"` : 'nothing'}. ` +
    'It is the repo\'s only record of a setting that lives in the\nNetlify ' +
    'UI, and without it nothing here can say what the API is meant to run ' +
    'on —\nwhich is the state #185 found and had to deploy a function to get ' +
    'out of.')
} else {
  console.log(`ok: ${CONFIG} declares the functions runtime as ${declaredRuntime}`)
}

/* A different number from the runtime's, and pinned in two files. The
   workflow only *says* it matches this one. */
const pins = [...fs.readFileSync(CI_WORKFLOW, 'utf8')
  .matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)/gm)].map(([, version]) => version)

if (!nodeVersion || pins.length === 0) {
  fail(
    `The build's Node version has to be readable from both ${CONFIG} and ` +
    `${CI_WORKFLOW},\nand ${!nodeVersion ? CONFIG : CI_WORKFLOW} does not ` +
    'have it in the shape this expects.')
} else if (pins.some((version) => version !== nodeVersion)) {
  fail(
    `${CONFIG} builds on Node ${nodeVersion} and ${CI_WORKFLOW} pins ` +
    `${[...new Set(pins)].join(', ')}.\nThe point of building in CI is to ` +
    'build the way Netlify does, so a green run says nothing\nabout the ' +
    'deploy once these two differ.')
} else {
  console.log(`ok: ${CONFIG} and ${CI_WORKFLOW} both build on Node ${nodeVersion}`)
}

/* Only a Netlify build is handed the real setting. On a laptop or in GitHub
   Actions there is nothing to compare the declaration against, and inventing
   something would make this pass for a reason unrelated to production. */
if (process.env.NETLIFY !== 'true') {
  console.log('skipped: AWS_LAMBDA_JS_RUNTIME is only visible to a Netlify build')
} else if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  fail(
    'AWS_LAMBDA_JS_RUNTIME is not set for this build, so nothing is pinning ' +
    'the functions runtime.\nNetlify documents the fallback as the Node ' +
    'version the build itself used, which would make\nthe runtime whatever ' +
    `NODE_VERSION happens to resolve to — Node ${nodeVersion} today, and ` +
    'Node 24\nwherever Netlify decides that version will not do. That is the ' +
    'invisible pinning this check\nexists to end, so it is a failure even ' +
    'though the site would deploy.\nSet it in the Netlify UI to ' +
    `${declaredRuntime}.`)
} else if (process.env.AWS_LAMBDA_JS_RUNTIME !== declaredRuntime) {
  fail(
    `Netlify is deploying the functions on ${process.env.AWS_LAMBDA_JS_RUNTIME}` +
    `, and ${CONFIG} declares ${declaredRuntime}.\nOne of the two is wrong ` +
    'and the repo cannot tell which: the runtime is set in the Netlify UI, ' +
    'so\neither the UI was changed without the declaration, or the ' +
    'declaration was changed\nwithout the UI. Whichever it was, production ' +
    'is about to run something the repo does not\ndescribe (#185).')
} else {
  console.log(
    `ok: Netlify is deploying the functions on ${declaredRuntime}, and this ` +
    `build is ${process.version}`)
}

if (bundler !== 'esbuild') {
  fail(
    `${CONFIG} must set node_bundler = "esbuild", and sets ` +
    `${bundler ? `"${bundler}"` : 'nothing'}.\n` +
    'Without it the functions ship with their dependencies beside them ' +
    'rather than inlined,\nand the runtime meets every module boundary ' +
    'directly. One ES-module-only package\nthen takes every route down at ' +
    'once — entries, stats, export, auth, the lot (#162, #185).')
} else {
  console.log(`ok: ${CONFIG} bundles the functions with esbuild`)
}

/* Externals are copied rather than inlined, so they are the one place the
   original rule still applies. */
for (const name of externals) {
  const error = run(['--no-experimental-require-module', '-e', `require('${name}')`])
  if (error) {
    fail(
      `${name} is in external_node_modules and cannot be required from ` +
      'CommonJS.\nesbuild does not inline an external, so the deployed ' +
      'runtime meets it directly\nand every route 502s while the module is ' +
      'being read.\nEither drop it from that list so it gets bundled, or ' +
      'hold it at its last CommonJS version.', error)
  } else {
    console.log(`ok: ${name} is external and requireable from CommonJS`)
  }
}

/* Not the production loader — that is the point of bundling. This is the
   plain smoke test the old job also gave us for free: a route whose requires
   do not resolve is broken long before ESM enters into it. */
if (!directory || !fs.existsSync(directory)) {
  fail(`${CONFIG} names a functions directory that does not exist: ${directory}`)
} else {
  for (const file of fs.readdirSync(directory).filter((f) => f.endsWith('.js'))) {
    const route = `./${path.posix.join(directory, file)}`
    const error = run(['-e', `require('${route}')`])
    if (error) fail(`${route} does not load.`, error)
    else console.log(`ok: ${route} loads`)
  }
}

if (process.exitCode) {
  console.error('See the "ES modules, the functions runtime, and why the API ' +
                'is bundled" section of CLAUDE.md.')
}
