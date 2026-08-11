# Maintaining the database

## You need an .env file

In order to use the scripts in this folder, you need
to create a `.env` file in this folder containing
`MONGODB_URL=...`

Scripts that talk to the external metadata APIs also need
the same keys the deployed API uses:
`TMDB_API_KEY` (films and TV), `TWITCH_CLIENT_ID` +
`TWITCH_CLIENT_SECRET` (games, via IGDB) and, optionally but
recommended, `GOOGLE_API_KEY` (books).

Run the scripts from this folder, so that `dotenv` picks up the `.env`.

## Auditing and backfilling metadata

`audit_database.js` is read-only, needs no API keys, and reports every
inconsistency it can find: works that can't be refreshed because they
have no usable apiRef, missing or corrupt metadata fields, games that
have a duration but no HowLongToBeat link, duplicate works sharing an
apiRef, orphaned works, and entries with a missing or dangling `workRef`.

```
node audit_database.js
node audit_database.js --only=games,books --json=./audit.json
```

`backfill_work_metadata.js` re-runs the API adapters for cached works and
fills in what's missing / refreshes what's stale. It is a **dry run unless
you pass `--apply`**, and it takes a JSON backup of each collection before
writing to it.

```
node backfill_work_metadata.js --only=games --missing-only
node backfill_work_metadata.js --only=games --missing-only --apply
```

Useful flags: `--only=films,tv,games,books`, `--missing-only` (only touch
works with gaps, instead of refreshing everything older than
`--max-age-days`, default 180), `--force`, `--limit=N`, `--delay-ms=N`,
`--json=path`, `--backup-dir=path`.

Notes on its behaviour:

- It only ever writes to the **work** collections. User overrides live on
  the entry documents (`entry.overrides`) and are never touched, so a
  refresh cannot clobber a value the user set by hand.
- A field the API returns nothing for is never cleared.
- `apiRefs` and `externalUrls` are merged, so a ref we already know about
  survives even if the API stops reporting it.
- Each refreshed work gets a `metadataUpdatedDate`, so an interrupted run
  can be resumed cheaply and periodic refreshes skip recent work.
- Duplicate works are reported, never merged — that's `dedupe_works.js`.

## Collapsing duplicate works

`populate_work_collections.js` created one work document per *entry*, so the
same film cached for two users became two documents; books were worse,
because the works controller looked them up under a different apiRef prefix
than the one they were stored under, so every retrieve made another copy.

`dedupe_works.js` merges each group of duplicates into the most complete
document, repoints the entries' `workRef` at it, and deletes the leftovers.
It only groups works that share an API identifier — never by title — and it
is a **dry run unless you pass `--apply`**. Read the dry run before applying:
it prints the survivor, what gets filled in, and a warning when duplicates
disagree about the title.

```
node dedupe_works.js --only=books
node dedupe_works.js --only=books --apply
```

Useful flags: `--only=...`, `--keep-duplicates` (merge and repoint but delete
nothing), `--json=path`, `--backup-dir=path`. Both the work and the entry
collection are backed up before anything is written.

Run it before a full `backfill_work_metadata.js`, so you aren't paying for an
API call per duplicate.

## Tests

The parts that decide what to write (`work_metadata_merge.js`) and what to
delete (`work_dedupe_plan.js`) are pure and dependency-free, and are covered
by `node --test`:

```
npm test
```

Keep it that way: the scripts should hold the I/O, and the rules should stay
in a module that can be tested without a database or an API key.

## History

We migrated from FaunaDB to MongoDB Atlas on 2022-10-10. The scripts that
use `faunadb` / `./utils.js` predate that migration and no longer run.

Two one-off scripts left the database in a state the backfill now repairs:

- `mongodb_add_missing_durations.js` set `duration` only, and not the
  `hltb__` apiRef or the HowLongToBeat `externalUrls` entry that should
  accompany it — which is why playtimes stopped linking out.
- `mongodb_add_missing_book_publishers.js` stored an un-awaited Promise,
  which Mongo wrote as an empty object, so those books have a `publishers`
  field that isn't a list of strings. The script itself is fixed now.

## Backing up the production DB

mongodump --uri="MONGODB_URL_GOES_HERE" --out=./mongobackup
