# Working in this repo

Notes for whoever (or whatever) picks this up next. Conventions the code
already follows, and the traps that cost someone a day the first time.

## Writing a PR description

**Put each paragraph on one long line.** GitHub renders single newlines in
issue and PR bodies as hard `<br>` breaks — unlike `.md` files in the repo,
where they're soft. Prose hard-wrapped at 72 or 80 columns comes out with a
forced break on every line, ragged and unreadable at any window width.

Wrapping is right in **commit messages** (72 columns) and in **`.md` files**
in the repo. It is wrong in anything GitHub renders as a comment: PR bodies,
issue bodies, review comments.

Lists, tables and fenced code blocks are unaffected either way — the rule is
about paragraphs.

Describe the code as it stands, not the path taken to it. A reviewer wants to
know what the branch does and which decisions are worth arguing with, not
what was tried first.

## Commits

`feat:` / `fix:` / `docs:` / `chore:` prefixes, optionally scoped
(`feat(db_maintenance):`). Say why, not just what — the diff already says
what. End with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## npm and Google Drive

**`node_modules` in the Drive-synced working copy is unusable.** Drive's
filesystem corrupts npm's many small writes and you get
`ERR_INVALID_PACKAGE_CONFIG` from packages that installed fine a moment ago.
An install takes 10+ minutes and then doesn't work.

Copy the repo to local disk (excluding `node_modules`, `.git`, `backups`
and `.env`), `npm ci` there — about 9 seconds — and invoke scripts by their
local path, pointing them back at the Drive copy's `.env` and `backups` so
the credentials and the snapshots never leave Drive:

```
MEMO_ENV_FILE=/path/on/drive/src/db_maintenance/.env \
  node C:/local/copy/src/db_maintenance/scripts/some_script.js \
  --backup-dir=/path/on/drive/src/db_maintenance/backups
```

The working directory no longer matters — a script resolves its `.env` from
`src/db_maintenance/env.js` and its backups from its own location, so a local
copy would otherwise quietly use the local copy's of each. `MEMO_ENV_FILE`
exists for exactly this; **don't** copy the `.env` to local disk instead.
`--out` / `--dir` do for the backup path what `--backup-dir` does above,
depending on the script.

Same trick for regenerating `package-lock.json`: run
`npm install --package-lock-only` on the local copy and copy the lockfile
back.

## ES modules, the functions runtime, and why the API is bundled

**The functions runtime cannot `require` an ES module, and `netlify.toml`
bundles the API with esbuild so that it never has to.** Both halves matter:
the constraint is real and permanent, and the reason you can ignore it most
of the time is one line of configuration that nothing else in the repo
asserts.

The failure it prevents is not a bad response from one route. The throw
happens while the module is being read, before a handler runs, so every
route 502s at once: entries, stats, export, auth, the lot. `uuid` 13 did
that to production (#162, fixed by #169) and `jose` 6 would have done it
again (#168).

**The mechanism, which #185 finally read rather than guessed.** A throwaway
function on a deploy preview reported `process.execArgv`, and AWS starts the
runtime with `--no-experimental-require-module` on the command line, by
name, next to `--no-experimental-detect-module`. Identical on `nodejs22.x`,
`nodejs24.x` and `nodejs26.x` — Nodes where `require(esm)` has been stable
and on by default for two releases or more. So this is AWS policy, not version drift: a newer
runtime will not grow out of it, and `NODE_OPTIONS` cannot undo it, because
a command-line flag beats `NODE_OPTIONS`. `process.features.require_module`
is `false` on the deployed runtime for that reason and no other.

**What esbuild does about it.** It inlines dependencies at build time, so
the deployed function has no module boundary left for the runtime to refuse.
The default bundler, `zisi`, copies each function verbatim and ships
`node_modules` beside it, which is exactly how the boundary used to survive
to production. With `node_bundler = "esbuild"` set, an ESM-only package in
the API is simply fine — verified on a preview, where `require` of an
ESM-only package returns cleanly on a runtime still reporting
`features.require_module: false`.

**`jose` is the first dependency to actually rely on that.** #144 held it
back for years as the hard one, #170 took it as far as 4.x and recorded
that `SignJWT` and `jwtVerify` there are already the API 5 and 6 want, and
#168 tried 6 and was reverted for exactly the reason above. Nothing about
the package has changed since: `node --no-experimental-require-module -e
"require('jose')"` still throws `ERR_REQUIRE_ESM` on 6.x. Only the bundler
underneath it changed, and #170's reading held, so the upgrade was
packaging rather than a rewrite.

What is worth knowing is that the tree is no longer single-version.
`openid-client` 5 asks for `jose` ^4, so npm nests a copy under it and
esbuild inlines both: the session token is signed and verified on 6, while
login and callback go on reaching 4 through `openid-client`. That is fine
— separate call graphs, and neither hands the other a key — and `npm ls
jose` is where it shows up. It stops being true when `openid-client`
reaches 6, which is a rewrite of that library's API and its own job
(#182).

**What still bites.** `external_node_modules` bypasses the bundler by
design, so anything in that list is copied rather than inlined and the
original rule applies to it unchanged. `mongodb` is there because it reaches
its optional native extras — `kerberos`, `snappy`, `aws4`,
`mongodb-client-encryption` — through requires inside `try`/`catch`, for
packages deliberately not installed, and a bundler has to resolve what it
inlines. Before adding anything to that list, ask the loader rather than
reading the package's own metadata — an `exports` map without a `require`
condition does mean ESM-only, but plenty of requireable packages ship no
`exports` map at all, and `mongodb` is one of them:

```
node --no-experimental-require-module -e "require('<pkg>')"
```

That flag turns off the `require(esm)` support the runtime does not have,
which is the whole trick. `scripts/check_function_dependencies.js` runs it
over every external and asserts the bundler is still esbuild, reading both
out of `netlify.toml` rather than keeping a copy that can drift.
`.github/workflows/ci.yml` runs that script.

It replaced a job that loaded every *route* under the same flag. That check
has outlived its question: the source still says `require('jose')` while the
artefact has jose inlined, so an ESM-only dependency would fail it and ship
perfectly well. A check that cries wolf gets deleted, and the real rule
would have gone with it.

**The runtime used to be pinned outside the repo, and #198 removed the pin
rather than mirroring it.** `AWS_LAMBDA_JS_RUNTIME` overrides the runtime and
Netlify reads it only from its UI, CLI or API — never from `netlify.toml`.
Set there, it kept the API on `nodejs18.x` for years — deprecated by AWS in
September 2025, Node 18 itself end-of-life since April 2025 — while
`netlify.toml` pinned `NODE_VERSION = "22"`, CI pinned Node 22, and this file
said the repo builds on Node 22 deliberately. All true, all about the build,
none of it about the runtime that serves requests, and nothing short of
deploying a function that reported `process.version` could have found it.

Netlify has derived the functions runtime from the build's Node since May
2023, and documents that variable as the way to *break* that link when the
two need to differ. They do not need to differ here. So the variable is gone
from the UI, `NODE_VERSION` in `netlify.toml` is the whole configuration —
one number, in the repo, for the build and the API alike — and
`scripts/check_function_dependencies.js` fails the deploy if a Netlify build
is ever handed that variable again. An override is now a failure rather than
a value to keep in sync, which is a much easier thing to get right than two
places that must agree.

**Why 24 and not something newer**, since #198 measured it and the number
looks arbitrary otherwise. AWS ships a managed Lambda runtime only for Node
majors on the LTS track, so there is no `nodejs25.x` and never will be.
`nodejs26.x` does exist, as a **public preview** — no SLA, no support,
breaking changes auto-applied, GA targeted for November 2026 — and Netlify
will not derive a runtime from it: a preview deploy built on Node 26,
`NODE_VERSION = "26"` asked for and honoured at `v26.1.0`, put its functions
on `nodejs24.x` anyway. Netlify substitutes rather than failing, and it
substitutes *after* the build, so nothing on the build side can see it
happen. Node 26 is therefore the one value this file cannot tell the truth
about, which makes it the #185 bug again with a different number. 24 is the
newest that stays true, and is generally available on Amazon Linux 2023 with
AWS support to April 2028. When 26 goes GA, this is a one-line change plus
the allowlist in the script.

The script keeps that allowlist — the majors Netlify will actually derive,
not the ones AWS ships — so a version that would be quietly substituted fails
before a deploy rather than being discovered after one. It also checks
`netlify.toml` against both CI pins, which `ci.yml` had only ever *said* it
matched, and on Netlify checks that the build really got the Node it asked
for, since that is what the functions inherit.

That setting is now load-bearing twice over. `mongodb` 7 requires Node
20.19.0 or newer and targets ES2023, and the driver is the one dependency
the runtime still meets directly: `external_node_modules` keeps it out of
the bundle, so nothing inlines or transpiles it on the way. Nothing catches
a runtime below that floor before the deploy either — `engines` is
advisory, and CI and Netlify both build on Node 22 whatever the functions
are given — and it would land as the same every-route-502 as an ESM
require.

**The remaining way out, if esbuild ever stops being enough**, is ES modules
for the functions themselves, which is what Netlify now recommends. That is
#185's route 3, and it was looked at properly and declined —
`docs/module_system.md` is the decision, what it rests on and what would
reopen it. The heart of it: esbuild flattens an ESM source to a CommonJS
bundle, so migrating changes nothing about what the runtime loads, while six
controller tests inject their fakes by monkey-patching `Module._load`, which
`import()` does not go through. Read that file before reading Netlify's
recommendation and reaching for this again.

## Credentials

`src/db_maintenance/.env` holds `MONGODB_URL`, `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `TMDB_API_KEY`, `GOOGLE_API_KEY`. Never print the
values, and never copy the file anywhere — if something can't see it from
where it is, point it at the file with `MEMO_ENV_FILE` rather than moving
the file to it.

Loading it is `src/db_maintenance/env.js`'s job, and every script's first
line is `require("../env")`. Don't call `dotenv` directly in a new script:
a bare `config()` resolves against the working directory, which is how the
scripts came to only work when run from one particular folder.

## Writing to the database

`src/db_maintenance/scripts/` operates on production data with real users'
entries. In order:

1. **Snapshot first, always, no exceptions.** Take a fresh snapshot with
   `scripts/backup_database.js` immediately before every `--apply`, and
   verify it — manifest counts, file counts and live `countDocuments()`
   should agree across every collection. There is no write small enough,
   safe-looking enough or reversible-looking enough to skip this: a snapshot
   costs seconds and is the only thing standing between a mistake and a
   restore. It applies to writes that touch no documents at all — an index
   build, a collection setting — because the reason to have the snapshot is
   that you were wrong about what the run would do.
   `scripts/restore_backup.js --from=<snapshot> --only=<collection>` matches
   on `_id` only.
2. **Dry run, and read the output.** Every script here is a dry run unless
   given `--apply`. Keep it that way in new ones.
3. **`--apply` against production is authorised**, given steps 1, 2 and 4.
   Say which snapshot you took and what the dry run said. Anything a restore
   from that snapshot would not undo — dropping a collection or an index,
   changing credentials, writing to a database other than `memo` — is still
   a human's call, so ask first.
4. **Verify afterwards**: no entry pointing at a work that doesn't exist, and
   entry counts unchanged.

Write only to the **work** collections. User overrides live on entry
documents (`entry.overrides`), so a script that never touches `*Entries`
cannot clobber one.

The one exception is `scripts/prune_orphan_reviews.js`, which deletes review
documents whose entry is gone — notes no code path can reach, since a review
is only ever looked up by `entryRef`. It reads `*Entries` but never writes to
them. Adding a second exception is a human's call: the rule is what keeps a
maintenance script away from text people can still read.

## Tests

`npm test` is `node --test`, and CI also parses every tracked `.js` file.

The suite runs with **no install, no database and no API keys**, and that is
worth protecting: put the logic that decides what gets written in a pure,
dependency-free module and the I/O in the script that calls it. In
`src/db_maintenance` that split is the folder layout — the modules and their
tests sit at the top, the scripts in `scripts/`. See
`work_metadata_merge.js`, `game_playtime_plan.js`, `work_dedupe_plan.js`,
`backup_plan.js` — and their tests.

Tests that do need the dependencies skip themselves when they aren't there.

## Data traps

- **`apiRefs` are flat strings** (`igdb__1234`), with a few legacy
  `{ name, ref }` objects. Some are placeholders — 27 games carry
  `hltb__N/A`, 14 films carry `undefined__undefined`. Use `parseApiRef` /
  `findApiRef` from `work_collections.js`, which reject those, rather than
  splitting on `__` yourself.
- **A shared apiRef is not proof two documents are the same work.** 44 of 78
  apiRef groups here are distinct works: "Fargo - Season 1" and "Season 2"
  under one show id, five Haruhi Suzumiya volumes under one ISBN. Merging on
  an apiRef alone destroys data.
- **A stored `duration` of `0` is not a duration.** It renders as `-` exactly
  as a missing one does.
- **`durationSource` records where a playtime came from.** `"igdb"` means
  IGDB's `/game_time_to_beats`; absent means it predates the field and came
  from HowLongToBeat. Never write one without writing the duration it
  describes. See `docs/API_choices.md`.
- **IGDB replaced `external_games.category`** with
  `external_games.external_game_source` (`1` = Steam). Querying the old field
  returns zero rows silently instead of erroring.
