# Why `src/api` is still CommonJS

#185 proposed three routes out of "the functions runtime cannot `require` an
ES module". Routes 1 and 2 were ways to keep the API on CommonJS; route 3 was
to move it to ES modules, which is also what Netlify now recommends for
functions. #190 took a fourth: bundle the functions with esbuild.

This is the decision not to follow route 3 yet, what it rests on, and what
would change it. It is written down because "we looked at it and decided not
to" is otherwise indistinguishable from "nobody got round to it", and the
next person to read Netlify's recommendation deserves better than having to
re-derive this.

## The short version

Bundling did not reduce the case for migrating. It removed it. With
`node_bundler = "esbuild"` the deployed artefact is CommonJS **whichever
module system the source is written in**, so migrating the source changes
nothing about what the runtime loads. The remaining arguments are modernity
and Netlify's recommendation, and the bill for them is `npm test` becoming
permanently dependent on an experimental Node API whose shape has already
changed once.

Cheaper than #185 thought, and worth much less than #185 thought. The second
of those moved a great deal further than the first.

## What esbuild does to an ESM source

Not asserted from the documentation — built, and the output read. An ESM
route bundled the way zip-it-and-ship-it bundles one (`bundle: true`,
`platform: "node"`, `format: "cjs"`) comes out as:

```js
// esm/route.mjs
var route_exports = {};
__export(route_exports, { handler: () => handler });
module.exports = __toCommonJS(route_exports);
```

The `import` statements are gone. `module.exports` is what ships. The
runtime's `--no-experimental-require-module` — the flag AWS passes by name,
which #185 read off `process.execArgv` — never meets a module boundary,
because the bundler left none for it to meet. That is already true today
with CommonJS sources, and it stays exactly as true with ESM ones.

So the migration does not remove a module boundary; there is none left to
remove. It does not unlock an ESM-only dependency; `jose` 6 and
`openid-client` 6 are unlocked already, and were the entire reason anyone
wanted it. Deployment benefit, measured rather than assumed: zero.

The one place the old rule survives is `external_node_modules`, which
bypasses the bundler by design — `mongodb` is copied rather than inlined, so
the runtime meets it directly. Source module system has no bearing on that
either. `scripts/check_function_dependencies.js` guards it and would go on
guarding it unchanged.

## What the migration would actually cost

**The test harness, and only the test harness.** Everything else about
`src/api` is unusually ready: 79 files, zero `__dirname` or `__filename`
between them, and the four `require('x').default` interop shims in the
adapters and `parsers/users.js` get *simpler* as ESM imports, not harder.

Six test files — `entries`, `name`, `revisions`, `stats`, `works` and
`auth_token` — inject their in-memory Mongo, their `jose` stub and their
`openid-client` stub by patching `Module._load`. (#185 counted four. It is
six now; the cost drifts upward while nobody is watching.)

They patch module resolution because there is nothing to pass. `db.js`
constructs its `MongoClient` at module top level:

```js
const mongoClient = new MongoClient(
  process.env.MONGODB_URL ?? throwIt('MONGODB_URL not set'), ...)
```

The singleton exists as a side effect of the import. A test cannot hand the
module a fake client because by the time it holds the module, the real one
is built. Intercepting the *resolution* is the only seam there is.

ESM has no `Module._load`. The replacement is `node:test`'s `mock.module`,
and it was tried:

- It needs `--experimental-test-module-mocks`. Without the flag the file does
  not skip, it **fails** — so `npm test` stops being a bare `node --test`
  for every developer and every CI run, permanently.
- Its options shape has already moved. `namedExports` was the documented form
  when the API landed in Node 22.3; on Node 24 it warns
  `options.namedExports is deprecated. Use options.exports instead.` That is
  the experimental-API risk arriving on schedule rather than in theory.

Trading a private-but-stable API for a public-but-experimental one, to make
the suite depend on a flag, in exchange for nothing — CLAUDE.md calls the
no-install, no-database, no-API-key suite worth protecting, and the same
argument protects no-flag.

**The alternative is better and does not need this migration.** Injecting
the dependencies as arguments — restructuring the `db.js` singleton and the
12 files that import it — gives better tests with no experimental anything.
It is worth doing on its own merits, in CommonJS, today. That is the whole
point: the good half of route 3 is separable from route 3.

## Three things #185 got wrong, all in the migration's favour

Recorded because they cut against the conclusion here, and a decision
document that only lists the evidence for itself is an advert.

1. **`"type": "module"` is not required.** Netlify takes ESM functions
   per-file as `.mjs`, and a bare `node --test` discovers `.test.mjs`
   alongside `.test.js` with no configuration — verified. The repo-wide blast
   radius #185 priced in — `.eleventy.js`, `src/frontend/_data/assets.js`,
   `jsconfig.json`'s `"module": "commonjs"`, and the 16 files under
   `src/db_maintenance` and `src/frontend` that do use `__dirname` — is
   avoidable in full.

2. **The chain no longer has to move together.** "A route importing a CJS
   controller solves nothing" was true when the runtime met every boundary.
   Under esbuild an ESM route importing a CJS controller bundles and runs —
   verified, output executed. A phased migration is available.

3. It is 79 files now, not 77.

None of this rescues the case. A migration that is easier than believed but
buys nothing measurable is still a migration that buys nothing measurable.

## What would change this

- **Bundling stops being the answer.** If Netlify defaults away from esbuild,
  or the API needs a dependency that has to go in `external_node_modules` and
  is ESM-only. Externals bypass the bundler, so that is the one live path
  back to the original failure — and it is the reason
  `check_function_dependencies.js` asserts the bundler is still esbuild.
- **`mock.module` goes stable and flag-free.** The cost above is almost
  entirely that flag. Without it this becomes a mechanical change.
- **The dependency-injection refactor happens first**, for its own reasons.
  Afterwards the six test files no longer need a module-resolution seam and
  the migration is a rename plus a `sed`.
- **Functions move off the bundler to native ESM** — #185's route 3 taken to
  its end, which is a different and larger argument than the one here.

## Not in scope, now or then

`src/frontend/_includes/js/**` is deliberately not a module system.
`asset_plan.js` concatenates 42 files, each wrapped in its own IIFE,
communicating through globals. Making it modules is #24 and stands or falls
on its own reasoning; it is not a rider on this one.
