# Maintaining the database

## What is where

`scripts/` holds the things you run. Everything beside this README is a
library: the pure modules that decide what a script should write, and their
tests.

The scripts, and the section below that explains each:

| Script | What it does | Writes? |
| --- | --- | --- |
| `audit_database.js` | Reports every inconsistency it can find — unrefreshable works, missing metadata, duplicates, dangling `workRef`s. Needs no API keys. | never |
| `backup_database.js` | Takes a timestamped snapshot of every collection and prunes old ones to a retention policy. | to disk only |
| `restore_backup.js` | Puts a snapshot, or one collection of it, back — matching on `_id`. | `--apply` |
| `ensure_indexes.js` | Creates the indexes the site's queries need. Re-running is a no-op. | `--apply` |
| `backfill_work_metadata.js` | Re-runs the API adapters over cached works, filling gaps and refreshing stale metadata. | `--apply` |
| `backfill_game_playtimes.js` | Fills in games with no playtime, from IGDB's `/game_time_to_beats`. | `--apply` |
| `dedupe_works.js` | Merges works that duplicate each other, repoints the entries and deletes the leftovers. | `--apply` |
| `prune_orphan_reviews.js` | Deletes reviews whose entry no longer exists, and so which nothing can reach. | `--apply` |
| `strip_dead_entry_fields.js` | Unsets `review` and `commonMetadata` from entry documents — a duplicated note and a stale copy of the work, neither of which any reader uses. | `--apply` |

Everything marked `--apply` is a **dry run without it**, and takes a backup of
each collection it writes to first — except `ensure_indexes.js`, which writes
no documents at all. The two backfills touch the **work** collections only, so
the overrides a user set by hand, which live on the entry documents, are out
of reach by construction; `dedupe_works.js` is the one that also writes to the
entry collections, repointing `workRef` at the document it merged into.

Two scripts write outside the work collections, and both say so in their own
section below: `prune_orphan_reviews.js` deletes review documents nothing can
reach, and `strip_dead_entry_fields.js` unsets two named dead fields from
entry documents. Neither can reach an override, and neither creates or
deletes an entry.

The commands below are written from this folder, as
`node scripts/audit_database.js`, but nothing depends on that. The `.env` and
the backups directory are both resolved from a fixed point in the tree rather
than from wherever you happen to be standing, so a script behaves the same run
from `scripts/`, from here, or by absolute path from anywhere else.

## You need an .env file

In order to use the scripts in this folder, you need
to create a `.env` file in this folder — not in `scripts/` — containing
`MONGODB_URL=...`

Scripts that talk to the external metadata APIs also need
the same keys the deployed API uses:
`TMDB_API_KEY` (films and TV), `TWITCH_CLIENT_ID` +
`TWITCH_CLIENT_SECRET` (games, via IGDB) and, optionally but
recommended, `GOOGLE_API_KEY` (books).

### How a script finds it

`env.js` owns this, and every script's first line is `require("../env")`,
before anything that reads `process.env`. Don't call `dotenv` directly in a
script: a bare `require("dotenv").config()` resolves against the **working
directory**, so it finds the file only when you happen to be standing in this
folder, and when it misses you get `MONGODB_URL not set` from a script that
is sitting next to the .env that has it.

`env.js` lives beside the `.env` and resolves it from its own location, so
the answer depends on neither the working directory nor how deep in the tree
the script sits. A script nested further down still writes `require`
followed by the path to `env.js`, and nothing about where the `.env` lives
changes.

Two ways to override it, in the order they win:

- **A variable already in the environment.** dotenv never overwrites one, so
  `MONGODB_URL=... node scripts/audit_database.js` works with no `.env` at
  all — which is what a scheduled backup on another machine wants.
- **`MEMO_ENV_FILE=/path/to/.env`**, to read a different file entirely. This
  is the one the Google Drive workaround in the root `CLAUDE.md` needs: the
  code runs from a copy on local disk while the credentials stay in the Drive
  copy, so neither has to be moved to meet the other. Never copy the `.env`
  to solve this — point at it instead.

## Indexes

`scripts/ensure_indexes.js` creates the indexes the site's queries need. It is
a **dry run unless you pass `--apply`**, and re-running it is a no-op:
`createIndexes` is idempotent for an identical spec, and these specs are named
the way MongoDB names them by default (`entryRef_1`), so an index made by hand
at the mongosh prompt is recognised rather than collided with.

```
node scripts/ensure_indexes.js           # what exists, what is missing
node scripts/ensure_indexes.js --apply
```

Flags: `--only=users,entryRevisions` (collection names, not the `films,books`
types the other scripts take), `--json=path`.

**These are applied to production, as of 2026-08-18 (UTC): all 23 of them.**
Nineteen were already in place before that date, from whenever #121 was first
run — nothing recorded it, which is what #147 was about. The four compound
`*Entries.userId_1_updatedDate_-1__id_1` indexes were created on that date,
over the snapshot `snapshot-2026-08-18T03-19-34-608Z`, and the winning plan
for the list query went from a blocking `SORT` to
`IXSCAN -> FETCH -> LIMIT` on all four entry collections.

`index_plan.js` has since grown a twenty-fourth,
`entryRevisions.entryRef_1_kind_1_userId_1` (#180), which has **not** been
applied. A dry run today therefore prints `23 index(es) already exist, 1 would
be created, 0 conflict`, and creating it is a second `--apply` for a human to
approve. Once that happens this paragraph should say 24 and 0.

If a dry run ever reports something to create that isn't that one, either
`index_plan.js` has grown another entry or an index was dropped behind its
back — both worth knowing before you reach for `--apply`.

Which indexes, and why each one, is declared in `index_plan.js` — every entry
names the queries that want it, because an index nobody can name a query for
is an index to delete. Most are single ascending fields: almost every query
the site makes goes through `findOneByField` / `findAllByField`, which is an
equality match on one field, and `_id` is indexed by MongoDB already.

- **`users.username` is unique**, which closes the check-then-write race in
  the rename path — `assignName` reads the name and writes it in two round
  trips, so two people claiming one name at the same moment both pass the
  read. A unique index refuses to build over existing duplicates, so the
  script looks for them first and prints the colliding documents instead of
  letting the driver throw. The dry run tells you whether it would succeed;
  if it wouldn't, that one index is skipped and the rest are still created.
  Two users with no username at all count as duplicates — MongoDB indexes a
  missing field as null.
- **The entry lists have a compound index**, `{ userId: 1, updatedDate: -1,
  _id: 1 }`, because `toUserEntriesPipeline` sorts as well as matches. An
  index serves a sort only when the sort is a prefix of what is left of the
  index after the equality match, so all three fields have to be there, in
  that order and those directions; with any less, the `$sort` becomes a
  blocking one in front of the `$limit`. The plain `{ userId: 1 }` index is
  kept beside it even though a compound index serves its own prefix — see the
  comment in `index_plan.js`.
- **`entryRevisions` has a compound index too**, `{ entryRef: 1, kind: 1,
  userId: 1 }`, because `findDraft` matches on all three — and it is the
  hottest read here, running once every 2.5 seconds while an edit form is
  open. On `{ entryRef: 1 }` alone the seek lands on the entry and the server
  filters the rest in memory, up to 50 documents each carrying a whole
  snapshot. `findRevisions` matches `{ entryRef, kind }`, this index's prefix,
  so the one index serves both.
- **The four `*Entries.workRef_1` indexes have no query behind them.** They
  were declared for the `$lookup` in the list query, which uses the index on
  the *foreign* side of the join (`works._id`), and nothing else filters on
  `workRef` — the maintenance scripts that care about it group in Node from a
  full read. They are declared honestly rather than dropped, because dropping
  an index is a human's call and undeclaring one would only leave it live and
  unexplained. See the comment in `index_plan.js` and #180.
- **`apiRefs` is an array**, so its index is a *multikey* index. That is
  correct, not something to fix: `findCachedWork` asks
  `{ apiRefs: "igdb__1234" }`, an equality match against one element, which
  is exactly what multikey serves.

Indexes are metadata — the script writes no documents and touches no user
data, so it needs no backup. It is a dry run by default anyway, because
building an index on a live collection costs I/O.

## Auditing and backfilling metadata

`scripts/audit_database.js` is read-only, needs no API keys, and reports every
inconsistency it can find: works that can't be refreshed because they
have no usable apiRef, missing or corrupt metadata fields, games whose
playtime has nothing to link it to, duplicate works sharing an apiRef,
entries whose `workRef` names a work that is gone, and reviews whose entry is
gone.

```
node scripts/audit_database.js
node scripts/audit_database.js --only=games,books --json=./audit.json
```

The summary prints those under a per-collection list of problems, and then a
short **not problems, for information** block. What goes in which is
`../audit_report.js`, and the distinction is worth reading before acting on a
count:

- **Entries with no linked work** are not damage. An entry the user typed in
  by hand, rather than picking from a search result, has no work to point at
  and carries its own metadata in `overrides` — which the list merges over
  `commonMetadata`, so it renders correctly. There are 23 of these, and the
  right number to repoint or delete is zero. They are only a line apart from
  the dangling-`workRef` count, which is a genuine broken reference, and
  reading one as the other is a mistake that has already been made once.
- **Cached works no entry points at** are leftovers of the metadata cache, not
  lost user data.

`reviews whose entry is gone` **is** a problem: a review is only ever found by
`entryRef`, so one whose entry is gone holds text no code path can reach.
There are 248 — 44 films, 14 tv, 150 games, 40 books.

None of them was written unattached. Every one was saved against an entry that
existed at the time and was deleted afterwards, and until
`fix: delete an entry's review along with the entry` (#117, 2026-08-12) a
delete removed the entry and left the review sitting there. The 248 are that
bug's whole backlog, not an ongoing leak.

The evidence, if it needs re-checking: Fauna-era ids are allocated in creation
order, at a rate of about 1.027e6 id units per millisecond, which fits the
3189 surviving numeric entries with zero violations — no entry's inferred
creation time lands after its `updatedDate`. Every one of the 177 numeric
orphan `entryRef`s decodes to a 2022 creation, sits *inside* the surviving id
range, and is a median of zero seconds from an entry that is still there, so
they were created in the same batches as their surviving neighbours. The
remaining 71 carry uuid `entryRef`s, so they postdate the FaunaDB migration
and can only be bounded as older than the earliest snapshot.

What was in them: **171 were empty**, because `createEntry` writes a review
document for every entry whether or not a note was typed. Of the 77 that held
text, **27 duplicated a note that still exists** — the same text, verbatim,
under a live entry, which is what deleting a row and re-adding the same title
leaves behind. **50 held text found nowhere else.**

All 50 were read before anything was deleted. Each was attributed to the work
it belonged to — from the note's own content plus 4-gram overlap against every
surviving note — and in every case the surviving note turned out to be the
fuller version, with the orphan an earlier draft. What genuinely did not
survive was 2,793 characters across 10 entries, mostly reference links
(comic readers, an RPCS3 setup guide, wikidot pages) and a block of weapon
notes on Blood. That was reported for hand-merging through the app rather than
written by a script: the note lives in **two** places — `entry.review` and the
review document, in sync across all 810 entries that carry both — and a script
writing one and not the other would create the first divergence in the
database. Editing through the app writes both and records a revision.

`scripts/prune_orphan_reviews.js` then deleted all 248, on 2026-08-19, against
snapshot `snapshot-2026-08-19T02-51-54-658Z`. Entry counts were unchanged
afterwards and the audit reports zero unreachable reviews.

That script is the one exception to "write only to the work collections", and
it is a narrow one: it reads `*Entries` but never writes to them, so no
override and no live note is reachable from it, and everything it removes is
restorable by `_id` from the snapshot it takes first. The rule it bends exists
to protect notes people can still read; these were, by definition, notes
nobody could.

`scripts/backfill_work_metadata.js` re-runs the API adapters for cached works
and fills in what's missing / refreshes what's stale. It is a **dry run
unless you pass `--apply`**, and it takes a JSON backup of each collection
before writing to it.

```
node scripts/backfill_work_metadata.js --only=games --missing-only
node scripts/backfill_work_metadata.js --only=games --missing-only --apply
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
- Duplicate works are reported, never merged — that's
  `scripts/dedupe_works.js`.

## Playtimes

`scripts/backfill_game_playtimes.js` fills in the games that have no
playtime, from IGDB's `/game_time_to_beats` endpoint. It is a **dry run
unless you pass `--apply`**, and it backs the `games` collection up before
writing.

```
node scripts/backfill_game_playtimes.js
node scripts/backfill_game_playtimes.js --apply
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

`scripts/dedupe_works.js` merges each group of duplicates into the most
complete document, repoints the entries' `workRef` at it, and deletes the
leftovers. It is a **dry run unless you pass `--apply`**.

A group is only merged when its documents share an API identifier **and**
agree about the title. Sharing an apiRef does not mean being the same work:
"Fargo - Season 1" and "Fargo - Season 2" sit under one show id, five Haruhi
Suzumiya volumes share one ISBN, and "Demons" is filed under The Da Vinci
Code’s. Groups that disagree are printed and skipped —
`--merge-title-mismatches` forces them through, and you should read every one
of them first.

```
node scripts/dedupe_works.js --only=books
node scripts/dedupe_works.js --only=books --apply
```

Useful flags: `--only=...`, `--keep-duplicates` (merge and repoint but delete
nothing), `--merge-title-mismatches`, `--json=path`, `--backup-dir=path`. Both
the work and the entry collection are backed up before anything is written.

Run it before a full `scripts/backfill_work_metadata.js`, so you aren't
paying for an API call per duplicate.

## Dead fields on entry documents

Two fields on an entry document are written and never read back:

- **`review`** — a second copy of the note. The note's home is the `*Reviews`
  collections, which is where `getReview`, the export and the history all read
  it from, and `toUserEntriesPipeline` projects the entry's copy away
  specifically so it cannot reach a response.
- **`commonMetadata`** — a snapshot of the work document the entry points at,
  taken before the `$lookup` existed. `getUserEntries` sets
  `commonMetadata: work.data` from the lookup *after* spreading the entry, so
  the stored value is overwritten on every read. These are not merely
  redundant, they are stale: they disagree with the `works` collections they
  mirror.

Measured over `snapshot-2026-08-19T02-51-54-658Z`, the two came to **3.21 MB
of the entry collections' 4.32 MB** — 1.9 MB of duplicated note across 1034
entries, and 1.2 MB of stale metadata across 3267 (762 of them literally
`null`). See #176.

`scripts/strip_dead_entry_fields.js` `$unset`s them. It is a **dry run unless
you pass `--apply`**, and it dumps each entry collection before writing to it.

```
node scripts/strip_dead_entry_fields.js
node scripts/strip_dead_entry_fields.js --fields=commonMetadata
node scripts/strip_dead_entry_fields.js --apply
```

Flags: `--only=films,tv,games,books`, `--fields=review,commonMetadata`,
`--json=path`, `--backup-dir=path`.

**Before it drops a note it proves the other copy is there.** Every entry
carrying a `review` must have a review document under its `_id` holding the
same text, verbatim — not merely a review document, the same text. An entry
that fails is printed and left entirely alone, `commonMetadata` included: a
document we cannot account for is not one to write to. The check is equality
rather than existence for a second reason, too. `toSnapshot` takes
`reviewText ?? entryData.review`, so a revision falls back to the entry's copy
when the review document has no text, and verbatim equality is exactly the
condition under which that fallback cannot change its answer.

It is the second script here that writes outside the work collections, and the
only one that writes to `*Entries`. What bounds it:

- It `$unset`s those two named fields and nothing else. `overrides`, `status`,
  `score`, the dates and `workRef` are unreachable from it, and an `$unset`
  can neither create, delete nor repoint a document.
- It never touches `updatedDate`. A write that bumped it would reorder every
  list on the site — a visible change to data nobody asked to change.
- It re-reads the collection afterwards and reports the entry count and what
  still carries each field, so a run that did something other than what it
  planned says so rather than exiting quietly.

**Applied to production on 2026-08-19 (UTC)**, against snapshot
`snapshot-2026-08-19T17-25-19-670Z` — verified first against live
`countDocuments()` and the manifest's own SHA-256s, all 14 collections
agreeing. The dry run matched every one of the 1034 notes to its review
document verbatim and refused none, and found 3267 stale metadata objects
(762 `null`). Applying removed both. The four entry collections went from
**4,320,256 bytes to 1,119,513** — 74% gone, and within 5 KB of what #176
predicted.

Afterwards: entry counts unchanged in all four collections (1527 / 548 / 1089
/ 660), the audit reports zero dangling `workRef`s and zero unreachable
reviews, the `*Reviews` collections are unchanged document for document, and
all 1034 notes were re-read from them verbatim.

The write side is a separate fix: the form's `readForm` sends
`commonMetadata: null` and `review` on every save, and the update path used to
store the request body wholesale. #171 (PR #183) validates a PATCH body
against what an entry may hold instead, which is what stops these coming back.
Until that lands, a run of this clears the backlog rather than settling the
question, and an entry edited through the form afterwards carries them again.

## Backing up the database, with history

`scripts/backup_database.js` writes a **snapshot**: a timestamped directory
holding one JSON file per collection plus a `manifest.json` with the document
counts and a SHA-256 of each file. Nothing is ever overwritten, so running it
regularly builds up a history you can go back through — which is the point,
since an accidental rewrite is only noticed some time after it happened.

```
node scripts/backup_database.js         # take a snapshot, then prune old ones
node scripts/backup_database.js --list  # what snapshots do we have?
node scripts/backup_database.js --prune-only
```

Every collection in the database is dumped, discovered at runtime, so a
collection added later is included without anyone remembering to add it to a
list.

Snapshots live in `src/db_maintenance/backups` (git-ignored) unless you pass
`--out=path`. That default is resolved from the script's own location, not
from the working directory, so a snapshot taken before this folder was
reorganised is still the one a restore finds.

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

`scripts/restore_backup.js` restores documents by `_id` from a snapshot. It
is a **dry run unless you pass `--apply`**, it refuses to restore a snapshot
whose files don't match its manifest, and it takes a fresh snapshot of the
current data before writing anything.

```
node scripts/restore_backup.js                           # dry run, newest snapshot
node scripts/restore_backup.js --only=bookEntries,bookReviews
node scripts/restore_backup.js --from=snapshot-2024-06-30T04-17-00-000Z --apply
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
`game_playtime_plan.js`), what to delete (`work_dedupe_plan.js`,
`orphan_review_plan.js`, `dead_entry_fields_plan.js`), which snapshots a
retention policy keeps (`backup_plan.js`) and which indexes are missing
(`index_plan.js`) are pure and dependency-free, and are covered by
`node --test`:

```
npm test
```

Keep it that way, and the folder split holds it in place: `scripts/` holds
the I/O, and the rules stay in a module up here that can be tested without a
database or an API key.

## History

Nothing here is a migration that has already run. Those get deleted once
they have done their job, because a one-shot that can't be run again is a
liability sitting next to scripts that can: it still looks runnable, it has
no dry run, and the only thing it can do now is damage. `git log` remembers
what each one did, which is the only thing anyone ever needs from it.

We migrated from FaunaDB to MongoDB Atlas on 2022-10-10. The scripts that
drove that era spoke FQL through a `db` export `src/api/utils/db/db.js`
stopped providing, so they threw on their first query — which, each being a
top-level IIFE, was as soon as they ran. `populate_mongodb.js` was the
migration itself, reading a `backup-2022-10-10/` that is long gone.
`mongo_update_tam_entries_with_new_userid.js` moved one user's entries to a
new id, both ids hardcoded.

`scripts/backfill_work_metadata.js` repairs books whose `publishers` is an
empty object rather than a list of strings, left by an un-awaited Promise in
`mongodb_add_missing_book_publishers.js` — which did that repair first,
badly, and is gone too.

Games added between the `howlongtobeat` package's silent death and 2026-08-11
have no playtime at all; `scripts/backfill_game_playtimes.js` fills those.
`mongodb_add_missing_durations.js` did the same job through that package and
went with it.

Games carrying a `duration` with no HowLongToBeat link are reported by the
audit and left alone: no API can add one now, and their playtimes are worth
more than IGDB's replacements would be.

## Taking a dump with the Mongo tools

`scripts/backup_database.js` is enough for our purposes and needs nothing
installed, but `mongodump` produces a BSON dump that `mongorestore`
understands:

```
mongodump --uri="MONGODB_URL_GOES_HERE" --out=./mongobackup
```
