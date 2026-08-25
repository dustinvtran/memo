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
 * Netlify derives the functions runtime from the Node version the build used,
 * so `NODE_VERSION` in `netlify.toml` is the whole configuration and there is
 * exactly one version number in the repo. What this guards is that it stays
 * that way.
 *
 * It has not always been that way. `AWS_LAMBDA_JS_RUNTIME` breaks the link,
 * and Netlify reads it only from its UI, CLI or API — never from
 * `netlify.toml`. Set outside the repo it kept the API on `nodejs18.x` for
 * years, deprecated by AWS in September 2025, while `netlify.toml` said Node
 * 22, CI said Node 22 and CLAUDE.md explained why Node 22 was deliberate. All
 * true, all about the build, none of it about the runtime serving requests,
 * and no way to find out short of deploying a function that reported
 * `process.version` — which is what #185 eventually did.
 *
 * So an override is a failure here rather than a configuration, and a Netlify
 * build is the only place that can see one: it is handed the variable if it
 * exists. `netlify.toml` runs this before the site is built.
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
 * `src/api` is ES modules now (`src/api/package.json` sets the type for that
 * subtree and nothing else). That changes nothing above: esbuild flattens an
 * ESM source to a CommonJS bundle, so the artefact the runtime loads is the
 * same either way — which is exactly why the migration was not urgent, and
 * `docs/module_system.md` is that argument. What it does change is how this
 * file loads a route to smoke-test it, `import()` rather than `require()`,
 * because that is now what the source is.
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
const { pathToFileURL } = require('node:url')

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
  const setsRuntime = /^\s*AWS_LAMBDA_JS_RUNTIME\s*=/m.test(toml)

  return { directory, bundler, externals, nodeVersion, setsRuntime }
}

/**
 * @type {(args: string[]) => string | null} The error, or null.
 *
 * Deliberately no placeholder credentials. They used to be set here because
 * `db.js` built its Mongo client, and the three adapters built theirs, while
 * their modules were being read — so loading a route without keys threw, and
 * this would have failed for the wrong reason. All four are built on first
 * use now, which is what let the controller tests stop intercepting
 * `require`. Passing the environment through untouched turns that into
 * something this asserts: a route must load without a single credential.
 */
const run = (args) => {
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' })
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

const { directory, bundler, externals, nodeVersion, setsRuntime } = readConfig()

/* The majors Netlify will actually derive a functions runtime from, which is
   narrower than the majors AWS ships and narrower still than the versions nvm
   can install for the build. AWS has no nodejs25.x and never will — managed
   runtimes appear only for Node majors on the LTS track — and #198 measured
   that a public preview does not count either: a deploy built on Node 26,
   asked for and honoured, put its functions on nodejs24.x. Netlify
   substitutes rather than failing, and it substitutes after the build, so
   nothing on the build side can notice. Hence a list, checked before a deploy
   rather than discovered after one.
   https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html
   https://docs.netlify.com/build/functions/optional-configuration/ */
const LAMBDA_NODE_MAJORS = ['22', '24']

/* Read from this file it does nothing, which is worse than harmless: the
   nodejs18.x lines that used to sit in netlify.toml are why nobody looked at
   the UI for years (#185). */
if (setsRuntime) {
  fail(
    `${CONFIG} assigns AWS_LAMBDA_JS_RUNTIME, which Netlify reads only from ` +
    'its UI, CLI or API.\nSet here it does nothing at all except look like it ' +
    'does, which is how the API spent\nyears on nodejs18.x while every file in ' +
    'the repo said Node 22 (#185).\nThe functions follow NODE_VERSION on their ' +
    'own; delete this line.')
}

if (!nodeVersion) {
  fail(`${CONFIG} must set NODE_VERSION, and it is what the functions run on ` +
       'as well as the build.')
} else if (!LAMBDA_NODE_MAJORS.includes(nodeVersion.split('.')[0])) {
  fail(
    `${CONFIG} builds on Node ${nodeVersion}, which Netlify will not turn ` +
    'into a functions runtime.\nIt substitutes Node 24 for a build version it ' +
    'cannot map, silently and after the\nbuild, so the API would end up on a ' +
    'version nothing here mentions and nothing here\ncould see. Netlify ' +
    `derives ${LAMBDA_NODE_MAJORS.join(' and ')}; pick one, or widen the list ` +
    'once a preview runtime\nreaches general availability (#198).')
} else {
  console.log(`ok: ${CONFIG} builds on Node ${nodeVersion}, which Netlify ` +
              'derives a functions runtime from')
}

/* The same number is pinned in two files, and the workflow has only ever
   *said* it matches this one. */
const pins = [...fs.readFileSync(CI_WORKFLOW, 'utf8')
  .matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)/gm)].map(([, version]) => version)

if (pins.length === 0) {
  fail(`${CI_WORKFLOW} does not pin node-version in the shape this expects.`)
} else if (nodeVersion && pins.some((version) => version !== nodeVersion)) {
  fail(
    `${CONFIG} builds on Node ${nodeVersion} and ${CI_WORKFLOW} pins ` +
    `${[...new Set(pins)].join(', ')}.\nThe point of building in CI is to ` +
    'build the way Netlify does, so a green run says nothing\nabout the ' +
    'deploy once the two differ — and this number now decides the functions ' +
    'runtime\ntoo, not just the build.')
} else if (nodeVersion) {
  console.log(`ok: ${CI_WORKFLOW} pins the same Node ${nodeVersion}`)
}

/* Only a Netlify build can see either of these. On a laptop or in GitHub
   Actions there is nothing to look at, and inventing something would make this
   pass for reasons unrelated to production. */
if (process.env.NETLIFY !== 'true') {
  console.log('skipped: only a Netlify build can see what is overriding the ' +
              'runtime, or what Node it got')
} else {
  if (process.env.AWS_LAMBDA_JS_RUNTIME) {
    fail(
      'AWS_LAMBDA_JS_RUNTIME is set to ' +
      `${process.env.AWS_LAMBDA_JS_RUNTIME} for this build, outside the repo.\n` +
      'It overrides NODE_VERSION for the functions and can only be set from ' +
      "the Netlify UI, CLI\nor API, so nothing in a checkout can see it or " +
      'contradict it. That is exactly how the API\nran on nodejs18.x for years ' +
      `while the repo said Node 22 (#185).\nDelete it in the Netlify UI; ` +
      `NODE_VERSION = "${nodeVersion}" is meant to be the only place.`)
  }

  /* Netlify honouring NODE_VERSION is what the functions inherit, so a build
     that quietly got something else is the runtime quietly getting it too. */
  const buildMajor = process.version.replace(/^v/, '').split('.')[0]
  if (nodeVersion && buildMajor !== nodeVersion.split('.')[0]) {
    fail(
      `${CONFIG} asks for Node ${nodeVersion} and Netlify built this on ` +
      `${process.version}.\nThe functions inherit the build's version, so ` +
      'they are about to run something the repo\nnever asked for.')
  } else {
    console.log(`ok: Netlify built this on ${process.version}, which is what ` +
                'the functions inherit')
  }
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
   plain smoke test the old job also gave us for free: a route whose imports
   do not resolve is broken long before the module system enters into it.
   `import()` rather than `require()` because the routes are ES modules, and
   a file url rather than a path because Windows drive letters are not. */
if (!directory || !fs.existsSync(directory)) {
  fail(`${CONFIG} names a functions directory that does not exist: ${directory}`)
} else {
  for (const file of fs.readdirSync(directory).filter((f) => f.endsWith('.js'))) {
    const route = path.posix.join(directory, file)
    const url = pathToFileURL(path.resolve(route)).href
    const error = run(['--input-type=module', '-e', `await import('${url}')`])
    if (error) fail(`${route} does not load.`, error)
    else console.log(`ok: ${route} loads`)
  }
}

if (process.exitCode) {
  console.error('See the "ES modules, the functions runtime, and why the API ' +
                'is bundled" section of CLAUDE.md.')
}
