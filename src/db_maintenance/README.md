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
have no usable apiRef, missing or corrupt metadata fields, games whose
playtime has nothing to link it to, duplicate works sharing an apiRef,
orphaned works, and entries with a missing or dangling `workRef`.

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
- A stored `duration` is only refreshed by the source that wrote it, which
  `durationSource` records. IGDB may update a playtime it supplied, but it
  never writes over a HowLongToBeat one. See "Playtimes" below.
- Duplicate works are reported, never merged — that's `dedupe_works.js`.

## Playtimes

`backfill_game_playtimes.js` fills in the games that have no playtime, from
IGDB's `/game_time_to_beats` endpoint. It is a **dry run unless you pass
`--apply`**, and it backs the `games` collection up before writing.

```
node backfill_game_playtimes.js
node backfill_game_playtimes.js --apply
```

Flags: `--limit=N`, `--json=path`, `--backup-dir=path`.

It looks every game up in batches of 500 ids, so the whole library costs
three requests rather than one per game, and it reports how many games have
a playtime before and after.

- **It never overwrites a playtime that is already there.** IGDB's times rest
  on a median of three submissions; the ones already stored came from far
  larger HowLongToBeat samples, and they measure a different thing — IGDB's
  `normally` runs about 1.36x HowLongToBeat's Main Story.
- Everything it writes is tagged `durationSource: "igdb"`. No
  `durationSource` means the playtime predates the field and came from
  HowLongToBeat. The two fields are written together or not at all, so the
  playtime column can tell them apart and link each to where it came from.
- A stored `duration` of `0` counts as no playtime: the column renders it as
  `-` either way, so filling it takes nothing away from anyone.
- It only writes to `games`, so entry overrides cannot be touched, and it
  re-reads what it wrote to check the counts before it exits.

Why IGDB and not HowLongToBeat: [../../docs/API_choices.md](../../docs/API_choices.md).

## Collapsing duplicate works

The work collections hold multiple documents describing the same work — in
some cases one per entry that referenced it.

`dedupe_works.js` merges each group of duplicates into the most complete
document, repoints the entries' `workRef` at it, and deletes the leftovers.
It is a **dry run unless you pass `--apply`**.

A group is only merged when its documents share an API identifier **and**
agree about the title. Sharing an apiRef does not mean being the same work:
"Fargo - Season 1" and "Fargo - Season 2" sit under one show id, five Haruhi
Suzumiya volumes share one ISBN, and "Demons" is filed under The Da Vinci
Code’s. Groups that disagree are printed and skipped —
`--merge-title-mismatches` forces them through, and you should read every one
of them first.

```
node dedupe_works.js --only=books
node dedupe_works.js --only=books --apply
```

Useful flags: `--only=...`, `--keep-duplicates` (merge and repoint but delete
nothing), `--merge-title-mismatches`, `--json=path`, `--backup-dir=path`. Both
the work and the entry collection are backed up before anything is written.

Run it before a full `backfill_work_metadata.js`, so you aren't paying for an
API call per duplicate.

## Backing up the database, with history

`backup_database.js` writes a **snapshot**: a timestamped directory holding
one JSON file per collection plus a `manifest.json` with the document counts
and a SHA-256 of each file. Nothing is ever overwritten, so running it
regularly builds up a history you can go back through — which is the point,
since an accidental rewrite is only noticed some time after it happened.

```
node backup_database.js            # take a snapshot, then prune old ones
node backup_database.js --list     # what snapshots do we have?
node backup_database.js --prune-only
```

Every collection in the database is dumped, discovered at runtime, so a
collection added later is included without anyone remembering to add it to a
list.

Snapshots live in `./backups` (git-ignored) unless you pass `--out=path`.

**Retention.** After each snapshot, the older ones are pruned to: every
snapshot from the last 14 days, then the newest of each of the 8 most recent
weeks that have one, then the newest of each of the 12 most recent months
that have one. Weeks and months are counted by the snapshots in them rather
than by calendar time, so a gap in the history doesn't shorten how far back
the policy reaches: what is bounded is how many snapshots you keep, not how
old they may be. Tune with `--keep-days=N`, `--keep-weeks=N`,
`--keep-months=N`, or turn it off with `--no-prune`. The newest snapshot is
always kept whatever the policy says, and a directory that isn't a snapshot
is never deleted.

**Scheduling.** The script has no state of its own, so `cron`, Task
Scheduler or any runner works — just give it `MONGODB_URL` and a `--out` that
is backed up itself (an external drive, a private bucket). Don't publish the
snapshots: a full dump includes the `users` collection. In particular, don't
upload them as GitHub Actions artifacts from this repo — artifacts of a public
repo can be downloaded by anyone.

## Restoring from a snapshot

`restore_backup.js` restores documents by `_id` from a snapshot. It is a **dry
run unless you pass `--apply`**, it refuses to restore a snapshot whose files
don't match its manifest, and it takes a fresh snapshot of the current data
before writing anything.

```
node restore_backup.js                                   # dry run, newest snapshot
node restore_backup.js --only=bookEntries,bookReviews
node restore_backup.js --from=snapshot-2024-06-30T04-17-00-000Z --apply
```

A document in the snapshot is written over whatever the database holds under
that id; a document the database has and the snapshot doesn't is left alone
unless you pass `--prune`. That default is deliberate — the usual reason to
reach for a backup is one entry that got clobbered, not a full rewind, and
`--only` plus the default keeps the blast radius to that one collection.

Matching is on `_id` and nothing else. Identifiers that look like they
identify a work (an apiRef, a title) do not: the database really does hold
27 games sharing `hltb__N/A` and two seasons of Fargo under one tmdb id, so
anything that grouped documents by those would merge unrelated records.

Useful flags: `--dir=path`, `--from=name|path`, `--only=a,b`, `--prune`,
`--no-safety-backup`, `--skip-verify`.

## Tests

The parts that decide what to write (`work_metadata_merge.js`,
`game_playtime_plan.js`), what to delete (`work_dedupe_plan.js`) and which
snapshots a retention policy keeps (`backup_plan.js`) are pure and
dependency-free, and are covered by `node --test`:

```
npm test
```

Keep it that way: the scripts should hold the I/O, and the rules should stay
in a module that can be tested without a database or an API key.

## History

We migrated from FaunaDB to MongoDB Atlas on 2022-10-10. The scripts that
drove the FaunaDB era spoke FQL through a `db` export that no longer exists,
so they threw the moment they were loaded. They have been deleted; `git log`
still has them if you need to know what one of them did.

`backfill_work_metadata.js` repairs books whose `publishers` is an empty
object rather than a list of strings, left by an un-awaited Promise in
`mongodb_add_missing_book_publishers.js`.

Games added between the `howlongtobeat` package's silent death and
2026-08-11 have no playtime at all; `backfill_game_playtimes.js` fills those.
`mongodb_add_missing_durations.js` did the same job through that package and
went with it.

Games carrying a `duration` with no HowLongToBeat link are reported by the
audit and left alone: no API can add one now, and their playtimes are worth
more than IGDB's replacements would be.

## Taking a dump with the Mongo tools

`backup_database.js` is enough for our purposes and needs nothing installed,
but `mongodump` produces a BSON dump that `mongorestore` understands:

```
mongodump --uri="MONGODB_URL_GOES_HERE" --out=./mongobackup
```
