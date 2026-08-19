/**
 * @file What CI checks about the API's dependencies now that esbuild bundles
 * the functions. Dependency-free on purpose, like the rest of the suite.
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

  return { directory, bundler, externals }
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

const { directory, bundler, externals } = readConfig()

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
  console.error('See the "API cannot depend on an ES-module-only package" ' +
                'section of CLAUDE.md.')
}
