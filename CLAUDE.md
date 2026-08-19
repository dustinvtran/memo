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

## The API cannot depend on an ES-module-only package

**Anything `src/api/routes/**` can reach has to be requireable from
CommonJS.** The deployed functions runtime cannot `require` an ES module.
The failure is not a bad response from one route — the throw happens while
the module is being read, before a handler runs, so every route 502s at
once: entries, stats, export, auth, the lot. `uuid` 13 did that to
production (#162, fixed by #169) and `jose` 6 would have done it again
(#168).

**Nothing local will tell you.** `require(esm)` works from Node 22.12, so
the suite, the CI install and the build all load an ESM-only package
perfectly happily — and this repo builds on Node 22 deliberately, so that
agreement looks like confirmation. The functions runtime is the only place
the difference shows, and you cannot get to it from here.

So after bumping anything the API imports, ask the loader rather than
reading the package's own metadata — an `exports` map without a `require`
condition means ESM-only, but plenty of requireable packages have no
`exports` map at all, and `mongodb` is one of them:

```
node --no-experimental-require-module -e "require('<pkg>')"
```

That flag turns off the `require(esm)` support the runtime does not have,
which is the whole trick. `.github/workflows/ci.yml` runs the same check
over every route:

```
node --no-experimental-require-module -e "require('./src/api/routes/entries.js')"
```

It is there because this has now cost one outage and nearly a second, and
it is the only thing in CI that behaves the way production does.

**When a package goes ESM-only, the fix is on our side, not theirs.** Take
the last version that still ships CommonJS — `jose` stays on 4 for exactly
this, and the code it wants is the code 5 and 6 want, so the eventual move
is packaging and not a rewrite — or drop the dependency for a platform
built-in, which is what `crypto.randomUUID` did for `uuid`.

Two ways out exist if that ever stops being enough, neither of them small:
`node_bundler = "esbuild"` in `netlify.toml` inlines ESM at build time so
the runtime never sees it (`mongodb` is the one to watch there — optional
native dependencies and dynamic requires are what `external_node_modules`
is for); or the functions become ES modules themselves, which is what
Netlify now recommends, but the controller tests mock their dependencies by
monkey-patching `Module._load`, so that is a test-harness rewrite before it
is anything else.

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
