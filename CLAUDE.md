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
local path **with the working directory still in the Drive copy**, so
`dotenv` reads the real `.env` and credentials never leave Drive:

```
cd /path/on/drive/src/db_maintenance
node C:/local/copy/src/db_maintenance/some_script.js
```

Same trick for regenerating `package-lock.json`: run
`npm install --package-lock-only` on the local copy and copy the lockfile
back.

## Credentials

`src/db_maintenance/.env` holds `MONGODB_URL`, `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `TMDB_API_KEY`, `GOOGLE_API_KEY`. `dotenv` reads from
the working directory, so run maintenance scripts from that folder. Never
print the values, and never copy the file anywhere.

## Writing to the database

`src/db_maintenance/` operates on production data with real users' entries.
In order:

1. **Snapshot first** with `backup_database.js`, and verify it — manifest
   counts, file counts and live `countDocuments()` should agree across every
   collection. `restore_backup.js --from=<snapshot> --only=<collection>`
   matches on `_id` only.
2. **Dry run, and read the output.** Every script here is a dry run unless
   given `--apply`. Keep it that way in new ones.
3. **Ask a human before the first `--apply`**, showing them the dry run.
4. **Verify afterwards**: no entry pointing at a work that doesn't exist, and
   entry counts unchanged.

Write only to the **work** collections. User overrides live on entry
documents (`entry.overrides`), so a script that never touches `*Entries`
cannot clobber one.

## Tests

`npm test` is `node --test`, and CI also parses every tracked `.js` file.

The suite runs with **no install, no database and no API keys**, and that is
worth protecting: put the logic that decides what gets written in a pure,
dependency-free module and the I/O in the script that calls it. See
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
