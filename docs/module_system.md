# The API's module system

`src/api` is ES modules. `src/api/package.json` is one line — `{ "type":
"module" }` — and it scopes that to this subtree and nothing else. The rest
of the repo is still CommonJS and was not touched.

This is #185's route 3. It was declined once, on the reasoning below, and
then done anyway once it became clear the thing blocking it was worth
removing on its own. Both halves are worth keeping, because the first is why
you must not assume this migration bought anything at deploy time, and the
second is the rule that keeps the tree loadable.

## Migrating changed nothing about what the runtime loads

This is the part to read before concluding that ESM sources made bundling
unnecessary. They did not.

The functions runtime is started with `--no-experimental-require-module` —
AWS passes it on the command line, by name, and #185 read it off
`process.execArgv` on `nodejs22.x` and `nodejs26.x` alike. So `require` of
an ES module throws while the module is being read, before a handler runs,
and every route 502s at once. That is #162 (`uuid` 13) and nearly #168
(`jose` 6).

`netlify.toml` answers it with `node_bundler = "esbuild"`, and esbuild
**flattens an ESM source into a CommonJS bundle**. Built with the settings
zip-it-and-ship-it uses, a route comes out as:

```js
var route_exports = {};
__export(route_exports, { handler: () => handler });
module.exports = __toCommonJS(route_exports);
```

The `import` statements are gone; `module.exports` is what ships. The
artefact was CommonJS before this migration and it is CommonJS after it. So:

- **Bundling is still load-bearing.** Turning it off does not now work
  because the sources are ESM — it breaks everything, exactly as before.
- **ESM-only dependencies were already fine**, from #190 onward, and this
  migration is not what made them fine.
- `external_node_modules` still bypasses the bundler by design. Anything in
  that list is copied rather than inlined, so the runtime meets it directly
  and must be requireable CommonJS. `mongodb` is the only entry.
  `scripts/check_function_dependencies.js` asserts both facts.

## What actually blocked it, and why that was worth fixing

Six controller tests injected their in-memory Mongo, their `jose` stub and
their `openid-client` stub by patching `Module._load`. ES modules have no
such hook, and `node:test`'s `mock.module` — the usual replacement — needs
`--experimental-test-module-mocks`, without which the files fail rather than
skip. That would have made `npm test` permanently dependent on an
experimental flag, against a suite CLAUDE.md protects for needing no
install, no database and no keys. Its options shape has already moved once:
`namedExports` was the documented form when it landed in Node 22.3 and warns
as deprecated on Node 24.

But the tests reached through the module system because **four modules built
clients while they were being imported**, leaving nothing to pass:

- `utils/db/db.js` constructed its `MongoClient` at module top level.
- `utils/external_api_adapters/tmdb_adapter.js` built its TMDB client the
  same way, throwing on a missing `TMDB_API_KEY`.
- `utils/external_api_adapters/games/igdb.js` threw at require time on
  missing Twitch credentials — with a comment complaining that this kills
  the cold start before any handler exists to report it.
- `utils/openid_client.js` wrapped `import("openid-client")` — the package is
  ESM-only from v6 — behind a CommonJS module whose *path* the suite patched,
  because `import()` does not go through `Module._load` at all. That module's
  own comment named this problem and called keeping it "to one module instead
  of seventy-seven" the cheaper trade.

By the time a test held any of these, the real thing existed. Intercepting
resolution was the only seam, and `mock.module` would have reproduced that
same reach-through with a flag holding it up rather than fixing it.

So the fix was not the migration. It was deferring construction to first
use and leaving ordinary seams — `useClient`, `useAdapters`, `useLoader`,
each called only by the suite. That is worth having in CommonJS on its own
merits, and once it was done the migration needed no experimental anything.

**One thing the migration did simplify outright.** Three test files probed
for `openid-client` with `require.resolve('openid-client/package.json')`,
because `require` of an ESM-only package answers "not installed" on a loader
without `require(esm)` — which would have skipped the file rather than
failed it. Under ESM that is just `await import('openid-client')`. The
workaround was load-bearing: a leftover `require.resolve` in an ESM file
throws `require is not defined`, the probe's own `catch` swallows it, and
the file skips itself while claiming the dependencies are missing. Which is
the failure mode worth stating plainly — **a probe that throws for the wrong
reason skips silently.** Run the suite with the dependencies installed and
confirm nothing skips; that is what catches it.

**The rule this leaves, which matters more than the module system:**
importing anything under `src/api` must not require a credential, open a
connection or construct a client. A missing key is a fault of the request
that needs it, not of the cold start of every route that happens to share a
module with it. `check_function_dependencies.js` now loads every route with
the environment passed through untouched, so a new import-time credential
read fails CI rather than waiting to fail a deploy.

## Scoping: why a nested `package.json`

Three ways to make Netlify take ESM functions, and the choice is not
obvious:

1. `"type": "module"` at the repo root. Rejected: it converts
   `.eleventy.js`, `src/frontend/_data/assets.js` and the 16 files under
   `src/db_maintenance` and `src/frontend` that use `__dirname`, none of
   which this change has any business touching.
2. Rename all 79 files to `.mjs`. Works — Netlify takes `.mjs` functions and
   a bare `node --test` discovers `.test.mjs` — but it is 79 renames plus
   every relative specifier, and it would have made
   `check_function_dependencies.js`'s `readdirSync(...).endsWith('.js')`
   filter match nothing and quietly check zero routes.
3. **A nested `src/api/package.json`.** Node takes `type` from the nearest
   `package.json`, so this scopes ESM to the subtree with the filenames
   unchanged. Bare specifiers still resolve up to the root `node_modules`,
   and esbuild honours it when bundling.

Option 3 is what is here. `jsconfig.json` follows it, and affects nothing
but an editor — no CI job runs `tsc`.

## The one place CommonJS still meets this tree

`src/db_maintenance` is CommonJS and requires four modules out of
`src/api`: `utils/work_types.js`, `utils/db/queries.js` and
`utils/external_api_adapters/games/time_to_beat.js`. Those are now ESM, so
this is `require(esm)`, which Node has had unflagged since 22.12 — and the
repo pins 24, in `netlify.toml` and in CI alike, so there is room to spare.

Two things to know about that:

- **The AWS flag does not apply here.** `--no-experimental-require-module`
  is passed to the *functions runtime*, and only `src/api/routes` is
  deployed. `src/db_maintenance` runs on a laptop.
- **`require(esm)` throws if the imported graph uses top-level await.** None
  of those three modules or their imports do. Adding one would break the
  maintenance scripts, and `index_plan.test.js` and
  `game_playtime_plan.test.js` are what would catch it — both run in CI's
  dependency-free job, so the boundary is exercised on every push rather
  than trusted.

## Still out of scope

`src/frontend/_includes/js/**` is deliberately not a module system:
`asset_plan.js` concatenates 42 files, each in its own IIFE, communicating
through globals. That is #24 and its own argument, not a rider on this one.
