# Maintaining the database

## What is where

`scripts/` holds the things you run. Everything beside this README is a
library: the pure modules that decide what a script should write, and their
tests. `load_adapter.js` is the one exception — it `require`s the real
adapters, so it is not in the no-install suite, and it lives up here rather
than in `scripts/` only because three scripts need it.

The scripts, and the section below that explains each:

| Script | What it does | Writes? |
| --- | --- | --- |
| `audit_database.js` | Reports every inconsistency it can find — unrefreshable works, missing metadata, duplicates, works filed under another work's id, dangling `workRef`s. Needs no API keys unless you pass `--verify-shared-refs`, `--verify-title-years` or `--verify-titles`. | never |
| `backup_database.js` | Takes a timestamped snapshot of every collection and prunes old ones to a retention policy. | to disk only |
| `verify_backup.js` | Checks a snapshot against its own manifest — every file present, hashing to the `sha256` recorded for it, holding the documents claimed. `--live` also counts the database beside it. | never |
| `propose_work_refs.js` | Searches each work with no identity ref, and each entry with no work, and writes a worklist of candidates to confirm. | never |
| `set_work_ref.js` | Gives one work the identity ref it has none of, after asking the API whether that id really names it. Renames it to the API's title when a person has said which of the two is right. | `--apply` |
| `link_entry.js` | Attaches a named entry to the work it belongs on, moves one off a sub-work that should never have been a work, and deletes a duplicate row. Takes its operations from a file a person filled in. | `--apply` |
| `restore_backup.js` | Puts a snapshot, or one collection of it, back — matching on `_id`. | `--apply` |
| `ensure_indexes.js` | Creates the indexes the site's queries need. Re-running is a no-op. | `--apply` |
| `backfill_work_metadata.js` | Re-runs the API adapters over cached works, filling gaps and refreshing stale metadata. | `--apply` |
| `backfill_game_playtimes.js` | Fills in games with no playtime, from IGDB's `/game_time_to_beats`. | `--apply` |
| `repair_durations.js` | Repairs `duration` values that cannot be true — a playtime multiplied by 60 one time too many. Only ever writes a value an entry override corroborates. | `--apply` |
| `dedupe_works.js` | Merges works that duplicate each other, repoints the entries and deletes the leftovers. | `--apply` |
| `clear_unusable_work_fields.js` | `$unset`s work fields whose stored value is present and unusable — `publishers: {}`, `externalUrls: [[]]`, `directors: [""]` — so the next backfill can fill them. | `--apply` |
| `propose_book_refs.js` | Proposes English editions for the books whose ISBN names another title, filtered hard and ranked, to a file a person approves; then repoints the refs that were approved. Never picks a candidate itself. | `--apply` |
| `prune_orphan_reviews.js` | Deletes reviews whose entry no longer exists, and so which nothing can reach. | `--apply` |
| `prune_unreachable_documents.js` | Deletes cached works no entry in any collection points at, and review documents holding the empty string. Two halves, run separately with `--only=works` / `--only=reviews`. | `--apply` |
| `clear_noop_overrides.js` | `$unset`s the `overrides.<field>` keys holding a byte-identical copy of the work's own value, so a corrected work can reach the page again. Leaves every different value, every `null`, and every entry with no work. | `--apply` |

Everything marked `--apply` is a **dry run without it**, and takes a backup of
each collection it writes to first — except `ensure_indexes.js`, which writes
no documents at all. The two backfills touch the **work** collections only, so
the overrides a user set by hand, which live on the entry documents, are out
of reach by construction; `dedupe_works.js` is the one that also writes to the
entry collections, repointing `workRef` at the document it merged into.

Four scripts write outside the work collections, and each says so in its own
section below: `prune_orphan_reviews.js` deletes review documents nothing can
reach, `prune_unreachable_documents.js --only=reviews` deletes review
documents holding nothing, `clear_noop_overrides.js` removes the overrides
that are copies of the work they override, and `link_entry.js` writes an
entry's `workRef` and the name it is filed under.

The last two are the ones that reach an override at all, and their exceptions
are about the overrides rather than in spite of them, so each argues the case
in its own file header and section rather than inheriting one.
`link_entry.js` is also the only script here that deletes an entry, and the
only one that creates a work outside a backfill. What holds it inside the rule
is that it is not a population: every operation names one entry by its id and
carries text a person typed for that row, so the script selects nothing and
infers nothing.

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

`scripts/audit_database.js` is read-only, needs no API keys by default, and
reports every inconsistency it can find: works that can't be refreshed because
they have no usable apiRef, missing or corrupt metadata fields, games whose
playtime has nothing to link it to, duplicate works sharing an apiRef, works
filed under an id that belongs to another work, entries whose `workRef` names a
work that is gone, and reviews whose entry is gone.

```
node scripts/audit_database.js
node scripts/audit_database.js --only=games,books --json=./audit.json
node scripts/audit_database.js --verify-shared-refs
node scripts/audit_database.js --only=films --verify-titles
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
- **Works sharing a show id** are how tv works. TMDB has one id per show and
  the site tracks each season as its own entry, so nineteen of these exist,
  they are all correct, and the right number is not zero.

### Works sharing an id

More than one work under one identity ref is three different things, and until
#290 the audit printed all three as "duplicate works sharing an apiRef" — 44
groups under one number nobody could act on. `../shared_ref_check.js` splits
them:

- **Duplicates**, whose titles agree. The same work cached twice, and what
  `dedupe_works.js` collapses.
- **Separate works by design**, which is tv and only tv. Reported as a note.
- **Collisions**: one id, two works that are not the same work, in a type
  where one id means one work. 25 of these, holding 53 works. `Among Us` is
  filed under The Wolf Among Us's IGDB id and carries its nine-hour playtime
  and its link; Dostoevsky's `Demons` is under The Da Vinci Code's ISBN and is
  600 pages because that is how long The Da Vinci Code is. Every one was
  filled in by a `--missing-only` backfill that took the apiRef at its word.

Which *side* of a collision is the misfiled one cannot be worked out from the
database — both documents look equally plausible — so `--verify-shared-refs`
asks. It retrieves each shared id once, 25 calls, and prints which of the
group's titles the id actually names:

```
- igdb__2933 names "Kingdom Hearts III"
    it is:     Kingdom Hearts III (322745318825263691)
    it is not: Kingdom Hearts (322745318981502539)
```

It is off by default because a diagnostic that spends someone else's rate
limit every time it runs is a diagnostic that stops being run, and because
that flag is the only thing here that wants the adapter keys.

Fifteen of the 25 were settled outright — the id belongs to the sequel and the
base game is wearing it, or the reverse. The other ten answered "none of
these", which is a real answer rather than a failure: `igdb__127111` names *The
Wolf Among Us: Episode 5 - Cry Wolf*, so both `The Wolf Among Us` and `Among
Us` were wearing an id that is neither of theirs, and `9781781101032` comes
back as *Harry Potter à L'école des Sorciers*.

**All 25 were repaired on 2026-09-03, and the audit reports none today.**
`repair_shared_refs.js` is what did it, and #351 deleted it: the population is
zero in all four collections and two guards stop it coming back — `mergeWork`
refuses a work whose title the API disagrees with (below), and the retrieve
route in `api/controllers/works.js` treats an ambiguous ref as a cache miss
rather than picking one of the matches, so a new entry cannot land on the
wrong side of a collision. Both have tests. What remains is the **detection**,
which is cheap and stays: `shared_ref_check.js` still splits the three cases
and the audit still prints the collision line, so if the impossible happens it
says so. The repair itself is in git history, which is where a migration whose
cause is fixed belongs.

### Works whose own id names something else

The section above is about two works sharing an id, which the database can be
asked about because the two documents disagree with each other. **One** work
under **one** id that belongs to something else disagrees with nothing, so no
amount of reading finds it — and it is by far the commonest case. A
`--missing-only` backfill dry run refuses 357 works over it, 23% of the
library, and until #327 the only trace was a line in the log: the audit's "no
`<prefix>__` ref (cannot be refreshed)" count is about works with no id at all,
and these have one, and it resolves.

`--verify-titles` asks. It retrieves every work carrying the ref its type is
refreshed by — about 1,400 calls, a quarter of an hour for the books alone,
which is why it is off by default and why a run without it prints how many
works it did not ask rather than three zeroes. `../title_match_check.js` splits
the answers three ways, because the three want three different answers:

- **The same title, spelled differently.** A leading article, a diacritic, a
  bookseller's series suffix, `Seven` against `7`. `comparableTitle` forgives
  all four, so these merge rather than being refused — this is the 69 works
  #327 recovered, `Truman Show` under the id for `The Truman Show`. Reported as
  a note, not a problem: nothing is broken, but a stored title that needed
  forgiving is one somebody may want to tidy.
- **One title contains the other**, which is triage and not a finding to act
  on. `Heart of Darkness` against `Heart of Darkness By Joseph Conrad` is one
  book; `House of Flying Daggers` against `Making of House of Flying Daggers`
  and `Ex Machina` against `Digitaria Ex Machina` are two works apiece.
  Containment is exactly the shape a search-result mistake takes, so it is
  never forgiven — and it cannot be condemned wholesale either.
- **A different title entirely**, which is mostly #290's damage reached from a
  third direction: `Pinnochio` under the id for `The Adventures of Buratino`.

Nothing here writes. Which of the two names the work is a human's call, and
correcting the stored title by hand is what lets the next backfill through.

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
`--max-age-days`, default 180), `--force`, `--limit=N` (overrides the
per-collection default described below), `--delay-ms=N`, `--json=path`,
`--backup-dir=path`.

Notes on its behaviour:

- It only ever writes to the **work** collections. User overrides live on
  the entry documents (`entry.overrides`) and are never touched, so a
  refresh cannot clobber a value the user set by hand.
- A field the API returns nothing for is never cleared.
- `apiRefs` and `externalUrls` are merged, so a ref we already know about
  survives even if the API stops reporting it.
- **Every outcome but an unanswered call gets a `metadataUpdatedDate`** — a
  work that was updated, one nothing changed on, one whose ref was refused
  (#333), one whose ref the API says it no longer holds, and one carrying no
  usable ref at all (those two, #352). The field means **last checked**, not
  last changed, and it is what the queue below is ordered by. Only a failure
  that might succeed tomorrow — a 429, a 503, a timeout — is left unstamped so
  that it is retried. The adapters already separate the two by error class,
  mapping a 404 to `errors.notFound()` and everything else to
  `errors.internal()`, and `isPermanentFailure` in
  `../metadata_refresh_plan.js` is what reads it.
- **Some fields are filled and never replaced.** Both titles, for every type,
  and a book's `releaseYear` and `duration`. See "What a refresh will not
  overwrite" below.
- A stored `duration` is only refreshed by the source that wrote it, which
  `durationSource` records. IGDB may update a playtime it supplied, but it
  never writes over a HowLongToBeat one. See "Playtimes" below.
- **A work whose stored title the API disagrees with is refused**, printed
  with a `!`, and left completely alone — the `entryType` repair included. The
  apiRef is the only thing tying the two documents together and it is not
  always telling the truth: filling a work in from whatever its ref names is
  how 53 documents came to carry another work's year, playtime, image and
  links. A genuine retitling lands here as well, and is meant to — correct the
  stored title by hand and the next run goes through. #290. A refused work is
  now stamped with the date it was asked, so a nightly crawl does not spend
  its budget re-asking the same permanently-refused works ahead of the ones it
  has never read; `--missing-only` ignores the stamp, so it still picks them
  up, and `--verify-titles` above is what diagnoses them. #333.
- **The titles are compared after a normalisation, not letter for letter.**
  Case, punctuation, diacritics, a trailing parenthetical, a leading English
  article and a spelled-out number below twenty are all forgiven, so `Truman
  Show` and `The Truman Show` are one film — 69 works were unrefreshable over
  exactly that. Equality after the normalisation and never containment, since
  containment is what a wrong search result looks like. `comparableTitle` in
  `../work_collections.js`, and `--verify-titles` above lists what is still
  refused. #327.
- Duplicate works are reported, never merged — that's
  `scripts/dedupe_works.js`.

### Refreshing, as opposed to filling gaps

Every `--apply` run this database has had was `--missing-only`, and that mode
cannot fix a value that is present and wrong. A game added while IGDB still
said its release date was TBD keeps that placeholder for ever; a playtime
HowLongToBeat has since re-estimated stays at the old number. Correcting
either needs the other mode — no `--missing-only`, so the age window decides
what is due — which **overwrites**, and is why the guards below are worth
reading before running one. #333.

The two modes select differently and neither is a weaker form of the other:

| | what makes a work due | what it writes |
| --- | --- | --- |
| `--missing-only` | the document has a gap or a corrupt field | only into the gaps |
| age-based (the default) | nobody has checked it in `--max-age-days` | every field the API is a better authority on |

`../metadata_refresh_plan.js` is the selection, and it is unit tested. The
queue is **longest-unchecked first**, with never-checked ahead of every date
and `_id` breaking ties, so `--limit=N` is a slice off the head of a queue
rather than an arbitrary handful: a run stamps what it read, the next run
carries on behind it, and two runs over the same data pick the same slice.
That is what makes a crawl something a schedule can do a piece at a time
against a daily rate limit.

**A work that can never succeed still has to leave the queue**, and that is
what #352 was. An unstamped work has no date at all, so longest-unchecked-first
sorts it ahead of everything else, for ever. The first autonomous run of the
nightly schedule spent its entire books slice on works in that state — `89
refused + 4 failed + 57 with no ISBN = 150` — and updated nothing, while
printing four green lines with ordinary-looking counts in them. #333 had
already fixed the refusals; the other two branches had not been part of it.

**The slice size is per collection**, out of `defaultLimit` in
`../work_collections.js` beside each collection's pause, and `--limit=N`
overrides all four for a watched run. One number across four collections was
the other half of that run: films, tv and games each cleared their whole due
list inside a slice of 150, while books ran out at 150 with 74 still waiting —
a shortfall that repeats nightly rather than one that catches up. Books is also
the only one of the four whose API caps a day rather than a rate, so it is the
one that most deserves a number of its own.

The run prints how far behind each collection is and how many runs of that
size would catch up:

```
=== games ===
  1151 works, 714 due, processing 150 (longest unchecked first) — 5 runs of this size to catch up
```

and `scripts/audit_database.js` prints the same gauge read-only, under each
collection's notes:

```
  metadata checked against the API: 714 never, 714 due (over 180 days), oldest 2026-08-11, newest 2026-09-03
```

A run exits non-zero when **every** API call it made failed, and only then. A
handful of failures is ordinary weather and stays green; nothing answering at
all is a spent daily quota, a revoked key or an API that has gone away, and it
looks exactly like a healthy run in every other count while leaving the queue
where it was. A run that made no calls at all — a slice of works that carry no
refs, which cost nothing to skip — is not that, and stays green; it used to go
red, because the guard counted works processed rather than calls made. #352.

### What a refresh will not overwrite

Three rules, all in `../work_metadata_merge.js` and all unit tested. The first
predates this and the other two are #333's.

**A stored playtime is only refreshed by the source that wrote it**, which
`durationSource` records. IGDB's times are a median of three submissions and
HowLongToBeat's of far more, so letting one replace the other would move
numbers people have already read, for the worse. See "Playtimes" below and
`../../../docs/API_choices.md`.

**Both titles are filled and never replaced.** The refusal above compares
titles after a normalisation that forgives quite a lot — deliberately, since
#327 — and that looseness is only safe while it decides whether to fill a
work, not whether to rename it. `The Stranger (Animorphs, #7)` filed under
Camus' ISBN reduces to the same string as `The Stranger`. If a ref does belong
to another work, the stored title is the only evidence left that it does, and
a refresh that rewrote it would leave the two indistinguishable — #290's
unrecoverable case. A genuine retitling stays a human's call.

**A book's `releaseYear` and `duration` are filled and never replaced**,
because an ISBN names an *edition*. A 60-book dry run on 2026-09-14 proposed
seven release-year changes; six of them replaced a stored year, and all six
moved a public-domain work forward to a modern reprint — `Robinson Crusoe`
1719 to a 2019 Flammarion, `The Autobiography of Benjamin Franklin` 1791 to
2019, `The Complete Poems of Emily Dickinson` 1890 to 2018, `The Wonderful
Wizard of Oz` 1900 to 2000. Not one was a correction, and page counts move the
same way for the same reason. Google Books is answering about the printing
rather than about the book, so it is not the better authority for those two.
It still is for the cover, the link and the publisher, which describe the
edition too and are worth having current — so those are refreshed. The
seventh change was a *fill*, onto a book with no year at all, and still
happens: fill-only is not read-only, and an edition's year beats the dash the
column draws now.

Films, tv and games have no equivalent: a TMDB movie id is one cut of one film
and an IGDB game id is one game, so nothing is fill-only for them beyond the
titles. A fourth type, or a field where the stored value is the better one,
goes on the collection's `fillOnlyFields` in `../work_collections.js`.

### The schedule

`.github/workflows/refresh_metadata.yml` is the nightly slice #3 asked for, at
03:40 UTC. **It has never run, and as configured it cannot: the repository has
none of the five secrets it reads.** A firing today would check out, `npm ci`,
and then die inside `backup_database.js` on an empty connection string, which
reads like a database fault rather than the unset setting it is. The
workflow's first step now checks all five and fails with the names of the ones
that are missing, before it installs or connects to anything (#338).

**What has to be true before this thing is live**, none of which is in the
repository and all of which is a repository setting (#301):

- **Five repository secrets** — `MONGODB_URL`, `TMDB_API_KEY`,
  `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `GOOGLE_API_KEY`. The values are
  the ones in `src/db_maintenance/.env`, and setting them is the first time
  those credentials exist anywhere but that one file on Google Drive — a
  deliberate widening, and the thing #336 accepted when it chose Actions over
  a Netlify scheduled function.
- **One repository variable**, `METADATA_REFRESH_APPLY`, set to `true`. Unset,
  the schedule runs and writes nothing, indefinitely.

Neither is set today. Both are the owner's to do, and a reader who wants to
know whether the crawl is running should check them rather than this file:
`gh secret list` and `gh api repos/dustinvtran/memo/actions/variables`.

A GitHub Action rather than a Netlify Scheduled Function because the job is
minutes of deliberate pausing between API calls rather than a request — the
site's functions have a ten-second ceiling — and because it has to write a
snapshot somewhere before it writes to the database, which a Lambda serving
the site does not have anywhere to put.

It follows the same discipline as a hand-run `--apply`, in the same order:
snapshot with `backup_database.js`, verify with `verify_backup.js --live`
(which exits non-zero on a bad snapshot, so the run stops before it writes),
then refresh, then audit. The snapshot is kept as a workflow artifact for 90
days, which would also be the first copy of this database that is not in the
Google Drive folder that holds the code and the credentials — a piece of #303,
though not that issue's answer, and not yet a copy of anything.

**A scheduled run is a dry run until `METADATA_REFRESH_APPLY` is `true`.**
Merging the workflow does not start a crawl of the whole library; turning it
on is a setting, changed by someone who has read a dry run and taken a
snapshot. Until then the nightly run is a ten-works-per-collection smoke test
rather than a full slice — enough to prove the five credentials still work and
to show where the queue stands, and not enough to spend a seventh of the daily
Google Books budget on a run that writes nothing. Once it is applying, the
slice is 150 per collection, which catches today's 2,547 due works up in about
ten nights. A `workflow_dispatch` run takes `apply` and `limit` as inputs, for
the watched case.

### How you would notice the schedule had stopped

This is the question #303 asks of every scheduled job here, and for this one
it was checked against GitHub's documentation rather than assumed. The short
answer is that **the default mail is not quite enough**, for three reasons
worth knowing before relying on it.

**A failed run does notify, but not "the owner" as a role.** GitHub sends
notifications for a scheduled workflow to a person fixed by authorship — the
docs say both "the user who last modified the cron syntax in the workflow
file" and "the user who initially created the workflow". Here those are the
same account and it works. But it follows whoever next edits the `cron` line,
which is not a property anyone would think to re-check after a routine edit.

**Failures-only is opt-in.** The Actions notification setting delivers every
completed run you are subscribed to; "Only notify for failed workflows" is a
dropdown you have to select. On a nightly job the default is a mail every
morning, which is in a filter inside a week — and a filtered folder is exactly
where a failure goes to not be read. If the mail is meant to be the alarm,
that setting has to be turned on.

**A stopped schedule does not fail; it goes quiet.** This is a public
repository, so scheduled workflows here "are automatically disabled when no
repository activity has occurred in 60 days". A disabled workflow produces no
run, so there is no failure to mail about. GitHub documents the disabling but
does not promise a notification for it, and re-enabling is manual — the UI,
the REST API, or `gh workflow enable`. That is not hypothetical here: this
repository has had three gaps of sixty days or more between commits, the
longest of them 872 days, from February 2024 to June 2026. A schedule merged
before any of those would have been off for most of it, quietly.

So the gauge that does not depend on the workflow being alive to report is the
audit's own freshness line, read by hand: `never checked` should fall by the
slice size each night and `oldest` should walk forward. Both standing still
means the crawl stopped, whatever the mail did or did not say. One thing does
work in the crawl's favour: the refresh script exits non-zero when every call
it made failed, so a spent quota or a revoked key is a failure rather than a
quiet success. That covers the crawl breaking. It does not cover the crawl
never being started, which is the state the repository is in today.

## Books filed under another book's ISBN

`--verify-titles` above ends by saying that which of two titles names the work
is a human's call and that nothing writes. For books there is a third answer,
and it is the commonest one: **both titles are right and they are the same book
in two languages.** `The Little Prince` is filed under `Le Petit Prince`,
`Brave New World` under `Le meilleur des mondes`, `Animal Farm` under `La ferme
des animaux`. The owner does not have the French editions, so the stored
`englishTranslatedTitle` is correct and the ISBN is not, and the fix is to
repoint the ref rather than to relax the guard or rewrite the title. #344.

Until that happens these books can never gain a publisher, a cover, a genre or
a page count, because the guard refuses every one of them every time.

`scripts/propose_book_refs.js` is two phases and only the second writes.

```
node scripts/propose_book_refs.js                        # propose, writes nothing
node scripts/propose_book_refs.js --limit=20
node scripts/propose_book_refs.js --from-report=refresh.json
node scripts/propose_book_refs.js --retry=proposals.json
node scripts/propose_book_refs.js --from=proposals.json   # what --apply would do
node scripts/propose_book_refs.js --apply --from=proposals.json
```

Flags: `--out=path`, `--markdown=path`, `--limit=N`, `--candidates=N`,
`--search-pages=N`, `--from-report=path`, `--retry=path`, `--delay-ms=N`,
`--from=path`, `--apply`, `--backup-dir=path`.

### Which books, and why it asks rather than lists

The population is **every book the backfill refuses**, derived by running the
backfill's own guard: the run makes the selection `selectForRefresh` makes with
`--missing-only`, retrieves through the same adapter, and calls the same
`mergeWork`. A pasted list would be stale the first time a title was corrected,
and a second copy of the title comparison would be a second thing to keep in
step with #327.

On 2026-09-14 that is **147 books of the 328 a `--missing-only` run would
fetch**, and six more whose ISBN Google Books no longer holds at all — `The Art
of War`, `Ulysses`, `Julius Caesar`, `1Q84`, `Carrie`, `A Wrinkle in Time`.
Those six are #343's population, not this one: there is nothing to refuse
because there is nothing to ask.

The 147 are not all translations, and nothing here has to tell them apart. Some
are plain misfilings — `A Christmas Carol` is filed under `281241572X`, which
is *Les Aventures d'Olivier Twist* — and some are a stored title carrying more
words than the ISBN's, which is #327's shape. All three are a book whose ref
names something else, and the same filters make the same repair safe.

The refusals cluster at the head of the queue, which is worth knowing before
reading a progress line: 144 of the first 150 books asked were refused and the
next 178 produced three. `selectForRefresh` sorts longest-unchecked first, and
a book that has never been successfully merged is a book that never got a
`metadataUpdatedDate`, so the two populations are very nearly the same set.

### Why it proposes instead of picking

Google Books answers a title search with English editions carrying ISBN-13s for
every title sampled, and its first hit is wrong often enough that taking it
would be #290 arriving by a new route. `The Little Prince` leads with a
116-page print-on-demand volume; `Brave New World`'s second hit is the omnibus
`Brave New World and Brave New World Revisited`, which is a different book;
`Animal Farm`'s top three are a publisher-less 56-page edition, a
Chinese-published one, and one of a single page.

So `../book_ref_proposal.js` filters hard — an English `language`, an ISBN-13,
a publisher, a page count of at least 10, a title that clears `titlesAgree`,
an author that does not contradict the stored one, and an ISBN no other book is
filed under — ranks what survives, and offers two or three per book. A book
with no survivor is listed as having none, with the volumes that got furthest
and the filter each fell at, rather than being given the best of a bad set.
**Nothing in the script chooses.** These books are in this state because
somebody once took a search result without reading it.

The page floor is measured rather than guessed: the shortest page count stored
on any of the 650 books is 11, so ten cannot refuse a book of the kind this
library holds while still refusing the 0s and 1s.

The author check is the one that is not decoration. `titlesAgree` is
deliberately loose, and `../work_collections.js` documents that looseness as
safe *because it compares one stored work against the answer its own id gave* —
which is exactly not what a search does. `The Stranger (Animorphs, #7)` reduces
to the same string as Camus' `The Stranger`, and a search for the one returns
the other. 326 of the 328 books with a gap carry an author, so the check has
teeth on nearly all of them.

### A search that could not run is not a search that found nothing

Google Books answers a sustained crawl with 429s, and a refused search page
comes back empty — indistinguishable from one that found nothing unless
somebody keeps count. The 2026-09-14 run collected 95 of them across 294 search
pages, which would have filed 46 books as having no English edition on the
strength of a question nobody got to ask.

So the count is kept per book and the file says **"Not searched"** rather than
"no candidate", the run exits non-zero, and `--retry=<the file>` searches those
books again and merges the answers back in — two calls each rather than another
sweep, since the refusals are already in the file. A retry that is throttled
too keeps whatever the earlier attempt found: `betterAttempt` in
`../book_ref_proposal.js`, and it is the same rule as everywhere else here —
an unanswered question replaces nothing.

### What a repoint writes

`apiRefs` is **narrowed**, the way #290's repair narrowed it: every
ref naming the old ISBN comes off under either prefix that names a book, the
new one goes on, and any other ref stays. Then the values that belong to the
*edition* rather than to the work come off, so the next `--missing-only`
backfill refills them from the ref that is now right:

| cleared | kept |
| --- | --- |
| `duration`, `imageUrl`, `metadataUpdatedDate`, the Google Books link | `releaseYear`, `publishers`, `genres`, `authors`, both titles |

`duration` is the one that has to go. A page count belongs to a printing and to
nothing else, and it is on books' `fillOnlyFields` since #333 — so a refresh
would *never* replace it, and a French edition's count left under an English
ISBN would stay wrong for good. `A Christmas Carol` is stored at 665 pages,
which is Oliver Twist's.

`releaseYear` stays for #333's reason rather than in spite of it: six of the
seven year changes a 60-book dry run proposed moved a public-domain work
forward to a modern reprint, `Robinson Crusoe` 1719 to 2019 among them. A year
stored on these books is far more often the work's first publication than the
French printing's, and clearing it would invite the next run to replace the
first with the second.

The line is *certainly the edition's* rather than *possibly the work's*, which
is narrower than #290's repair drew it — that had evidence
per value, because a value copied onto two documents in a collision group is
one retrieve's output, and there is no partner document here to compare
against. `publishers` is the field it looks least right on and it is kept
anyway: Gallimard really did publish `Le Petit Prince` first.

### What stops it filing two books under one ISBN

Three checks, because a shared identity ref is the state #290 found and #308
spent two rounds cleaning up:

1. A candidate whose ISBN another book already holds is never offered.
2. An approval is re-checked against the collection as it stands, and against
   the other approvals in the same file — neither of a pair is in the database
   yet, so only counting the file catches that one.
3. After the write, the whole collection is re-read and every ISBN counted.

The approved ISBN is also **verified against Google Books again, immediately
before the write**, the way #290's repair re-ran its identity checks
rather than trusting a saved answer. An approval whose ISBN no longer names the
stored title is skipped — which also means an approval that would not unblock
the backfill is refused, since it is the same `titlesAgree` either way. #343
asks for that shape for the 191 works with no ref at all, one population over.

### The run applied on 2026-09-15

Of the 147 refused books, 67 had a candidate that cleared every filter and 52
of those were approved by hand. The write repointed **48** and cleared **166
stored values**; 650 books, 660 entries and 202 reviews before and after, no
dangling `workRef`, and no ISBN held by two books.

The four that were approved and not written are the useful part. Each was
skipped because the re-verification asked Google Books what the approved ISBN
names and got back a title that no longer matched:

```
The Idea Factory: Bell Labs and ...   names "The Idea Factory"
Inanna, Queen of Heaven and Earth ...  names "Inanna"
Elementary Analysis: The Theory of ... names "Elementary Analysis"
Stat Labs: Mathematical Statistics ... names "Stat Labs"
```

All four are the same shape: a search result carries `title` **and**
`subtitle` and `retrieve` returns only `title`, so a book stored under its
full subtitled name matches a candidate at proposal time and fails the guard
at write time. Repointing them would have bought nothing, because the backfill
would refuse the new ref for the same reason. The fix for those is the stored
title, which is #327's business — and the re-verify is what caught it, which is
the argument for asking again at the moment of the write rather than trusting
the file.

Three more were declined before that for the same underlying reason, having
already been filed under the only candidate offered: `The Life-Changing Magic
of Tidying Up`, `A Mathematician's Lament` and `Lucifer Book One`.

The other twelve declines were editions rather than works: the only candidates
left were print-on-demand or scan reprints — Forgotten Books, Nabu Press,
Andesite, CreateSpace, Independently Published, and for `David Copperfield`
E-Kitap Projesi, which is the house #344 names as the wrong answer for `The
Little Prince`. They pass every filter here and are still the wrong printing,
which is why the last call is a person's.

**45 of the 147 were never searched at all**, because Google Books spent the
run's rate limit (95 refused pages out of 294). They are marked in the file
rather than counted as books with no English edition, and `--retry` finishes
them on a later day's quota.

The proposal file itself is not in the repo. It is a report, and reports live
in `backups/` with the snapshots — `book_refs_2026-09-14_applied.json` beside
the `books_*.json` the run wrote before it touched anything.

### The rate limit

Google Books gives about a thousand calls a day. A propose run costs one call
per book a `--missing-only` backfill would fetch — 328 of the 650 today — plus
two per refused book, so a full run is roughly 620 and two of them in one day
are not. `--from-report=<a backfill --json report>` reuses the refusals a
backfill run has already found and skips the sweep; `--limit` stops the sweep
as well as the proposing, so a run sized to a budget spends its calls on the
books it will actually propose for.

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

## Durations that cannot be true

`scripts/repair_durations.js` looks for `duration` values that are the right
*type* and still impossible, and repairs the ones it can prove a value for.
It is a **dry run unless you pass `--apply`**.

```
node scripts/repair_durations.js
node scripts/repair_durations.js --only=games
node scripts/repair_durations.js --apply
```

Flags: `--only=a,b`, `--json=path`.

**`duration` is four different units.** Minutes for a film, minutes for *one
episode* of a show, minutes for a game, and **pages** for a book. So there is
no single threshold — `../duration_plausibility.js` carries a ceiling per
type, set to clear the real record holders rather than the typical ones.
RuneScape really is stored at 127,680 minutes, and a ceiling that flags it is
a ceiling someone switches off.

**Why the audit missed this for years.** `isCorruptNumber` asks whether a
value is a number that isn't `NaN`. `2939328000000000` is one. Dying Light
was stored at 5.6 billion hours and the playtime column rendered it, linked,
like any other row. `audit_database.js` now reports the plausibility check as
its own finding, separate from `corrupt field values`, because the two ask
different questions.

**Where a repaired value comes from.** Not from dividing until the number
looks reasonable. 2939328000000000 is exactly 1050 × 60^7 — a units
conversion applied to a value already in the right units, seven times over —
and undoing those one at a time gives a ladder of candidates. But 63000 is on
that ladder too, and 63000 minutes is *inside* the games ceiling, so "divide
until it looks plausible" writes 1,050 hours and passes every check we own. A
ceiling says which values are impossible; it cannot say which possible one is
true.

The value comes from `overrides.duration` on the entries instead. Four of the
six Dying Light entries carry exactly 1050, typed by people who could see the
column was wrong. When an override lands on a rung of the ladder, two
independent accounts agree about what happened, and that is the only case
this script writes in. Everything else is reported with its ladder attached
for a human to settle — A Killer Paradox is stored at 425 minutes *per
episode*, which is its whole eight-episode run, and TMDB now returns an empty
`episode_run_time`, so there is nothing to repair it from.

Overrides are **read** and never written, so the rule that a maintenance
script touches only the work collections holds. `durationSource` is left
exactly as it is: the repaired number is the same measurement its source
gave, with the multiplications undone.

**The run.** Dying Light was repaired from `2939328000000000` to `1050` on
2026-08-25, against snapshot `snapshot-2026-08-25T07-37-41-272Z` (verified
first: manifest counts, file counts and live `countDocuments()` agreed across
all 14 collections, SHA-256s included). Afterwards every collection count was
unchanged, no entry pointed at a missing work, the six `gameEntries`
overrides were byte-for-byte what they had been, and the audit reports zero
implausible durations in `games`. `durationSource` stayed absent, so the
playtime still links to HowLongToBeat, which is where 17.5 hours came from.

A Killer Paradox was left alone, and still is.

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

## Field values that are present and unusable

`audit_database.js` reports 637 field values across the four work collections
whose stored shape is unusable — not missing, but there and wrong:

```
   587  books.publishers   = {}
    24  tv.apiRefs         = absent
    14  films.externalUrls = [[]]
     6  films.directors    = [""]
     4  books.apiRefs      = absent
     2  tv.directors       = [""]
```

Each shape has a known cause. `{}` is an unawaited Promise written to Mongo —
`work_collections.js` names the script that did it. `[[]]` is an empty array
wrapped in an array, so `externalUrls[0].url` is `undefined` and the Title
column falls back to a Wikipedia search for the title. `[""]` is an array
holding one empty string, which the Director column renders as an empty
clickable `<a>` pointing at a search for nothing. See #291 for the census, and
#292 for the render crash `publishers: {}` causes in `listOfLinksFormatter`.

None of it heals itself, and that is `mergeWork` working as intended: it only
ever writes a field the adapter returned a **non-empty** value for, and its
first rule is that a field the API has nothing to say about is never cleared.
That rule is what stops a bad API day emptying the database. But it means a
corrupt value can be replaced and never removed, so the 78 books Google Books
has no publisher for keep their `{}` however many times the backfill runs.

`scripts/clear_unusable_work_fields.js` `$unset`s them. It is a **dry run
unless you pass `--apply`**, and it dumps each work collection before writing
to it.

```
node scripts/clear_unusable_work_fields.js
node scripts/clear_unusable_work_fields.js --only=books --fields=publishers
node scripts/clear_unusable_work_fields.js --apply
```

Flags: `--only=films,tv,games,books`, `--fields=publishers,externalUrls,...`,
`--json=path`, `--backup-dir=path`.

**`$unset`, not `$set`.** The point is not to replace a bad value with a
harmless one — it is to leave the field *missing*, because missing is what
`isEmptyValue` recognises. A cleared field reads as a gap, so `hasGaps` picks
the work up on the next ordinary `backfill_work_metadata.js` and fills it if
the API has anything to say. Written as `[]` or `null` instead, the value
would still be stored, still be read out of Atlas on every list load, and
still be something the merge has to have an opinion about.

**What counts as unusable is the audit's own answer, not a second copy of
it.** `unusable_field_plan.js` calls `isCorruptStringArray`, `isCorruptNumber`
and `isCorruptExternalUrls` from `work_collections.js`, which is what
`corruptFieldsOf` counts the 637 with. A script that restated the rules would
be a second thing to drift, and it would drift towards clearing values the
audit never complained about.

**Two of the fields the audit calls corrupt are out of its reach.** `apiRefs`
is reported when it is *absent* — 24 tv and 4 books — so there is nothing to
unset and those works belong on the cannot-be-refreshed list instead.
`entryType` is reported when it disagrees with the collection it sits in, and
the answer to that is the right constant, which `mergeWork` writes on every
refresh; unsetting would take a wrong value to no value. Naming either in
`--fields` is refused by name rather than quietly planning nothing.

**A value that still holds something usable is printed and left alone.**
`["", "Christopher Nolan"]` is corrupt by the same predicate as `[""]`, and an
unset would take the director with it; salvaging one is a `$set`, which is a
different decision from this one. Which elements survive is asked of the same
predicate one element at a time, so it cannot answer differently from the
check that flagged the field. All 609 values in production are unusable end to
end, so this list is expected to be empty — which is why it is printed.

It writes only to the **work** collections, so it needs no exception to
"write only to the work collections" and no `*Entries` document is in reach by
construction — the same guarantee the two backfills have. What else bounds it:

- It only ever `$unset`s. It cannot create, delete or repoint a document, and
  it cannot write a value of any kind.
- It touches no `metadataUpdatedDate`. That records when an adapter last had
  something to say about a work, and removing a value nothing can read is not
  the adapter saying anything.
- Re-running is a no-op: an absent field is not an unusable one, so a second
  pass plans nothing.
- It re-reads each collection afterwards and re-plans against it, so a run
  that did something other than what it planned says so rather than exiting
  quietly.

**Not yet applied to production.** The dry run of 2026-09-02 found 609 values
across 603 work documents — 587 `books.publishers`, 14 `films.externalUrls`,
6 `films.directors` and 2 `tvShows.directors`, which is the census above less
the 28 absent `apiRefs` — and nothing it had to leave alone. Applying it wants
a fresh snapshot taken and verified immediately beforehand, as everything in
this folder does.

## Overrides that override nothing

An override on an entry shadows the work's own metadata in the two places the
merge happens — the row builder in `components/list/list.js` and
`withOverrides` in `api/utils/export_view.js` — so a value stored there beats
the works collection for ever. Until #321, `readForm` compared the form
against `data.apiData`, a name nothing in the frontend sets. Every comparison
was therefore against `undefined`, every field came back different, and every
save wrote the whole form back as the user's overrides.

Measured against production on 2026-09-14:

```
entries carrying an overrides object: 1087
  override keys in total:            8511
  null/undefined (a cleared field):  1519
  identical to the work's own value: 5982   (~261 KB)
  genuinely different (a real one):  1010
entries whose every non-null override is a no-op: 509
```

The bytes are the smaller half. The real cost is that those 5982 fields are
pinned to whatever they happened to be on the day the entry was last saved: a
backfill applied 398 corrections on 2026-09-14, 341 of them TV shows that
gained a director, and not one of them is visible on an entry carrying a stale
copy of the value it corrected. #336 has since put that refresh on a daily
schedule, pointed at data half of whose corrections cannot reach the page.
See #317, and #171 and #176 for the same shape one field over.

`scripts/clear_noop_overrides.js` `$unset`s them. It is a **dry run unless you
pass `--apply`**, and it dumps each entry collection before writing to it.

```
node scripts/clear_noop_overrides.js
node scripts/clear_noop_overrides.js --only=games --show-kept=all
node scripts/clear_noop_overrides.js --apply
```

Flags: `--only=films,tv,games,books`, `--show-kept=n|all`, `--json=path`,
`--backup-dir=path`.

### Why this one is allowed to write to `*Entries`

The rule in `../../CLAUDE.md` is that maintenance scripts write to the **work**
collections, because user overrides live on entry documents and a script that
never touches `*Entries` cannot clobber one. This script's entire job is to
touch them, so the exception is argued rather than assumed.

The argument is that **a value byte-identical to the work it overrides is not
a user decision**. Nobody typed it; it is the artefact of a comparison against
`undefined`. And removing it changes nothing a reader sees, because both
merges produce the same value whether the copy is there or not — which is the
test, and it is the same test #176 had to pass for a field nothing reads.

What bounds it:

- It only ever `$unset`s `overrides.<field>` keys it has compared, one key at
  a time, and removes the `overrides` object itself only when the comparison
  accounted for every key in it. `status`, `score`, the dates, `workRef` and
  the note are unreachable from it, and an `$unset` can neither create, delete
  nor repoint a document.
- **A `null` is never touched.** It is the form's way of saying "the work's
  value is wrong and there is no replacement" — see `asOverride` in
  `utils/entry_form_io.js` — so removing one would un-clear a field somebody
  deliberately cleared, which is a visible change to their list. This is the
  easiest thing here to get wrong and the only one that loses data silently.
- **A different value is never touched**, and every one is printed with the
  work's value beside it rather than left as a count. A survivor count is the
  one number nobody can check afterwards.
- **An entry with no readable work is skipped entirely.** For the 23
  hand-typed entries that point at no work, `overrides` is not a layer over
  the metadata, it *is* the metadata. A dangling `workRef` is skipped the same
  way: a work we cannot read is not one to decide against.
- It never touches `updatedDate`, which would reorder every list on the site.
- It re-reads the collection afterwards and reports the entry count, so a run
  that did something other than what it planned says so.

**The comparison is against the work document, and this is the trap.** Both
the row builder and `getUserEntries` hand out a `commonMetadata` with the
overrides already folded into it, and the stale `commonMetadata` still stored
on some entries is #176's pre-migration snapshot of the same shape. Comparing
against either would find every override identical to itself and propose
deleting all 8511, the real ones included. `planNoopOverrideRemoval` is handed
the works and joins them itself, so there is no call site left that could pass
the wrong baseline, and `noop_override_plan.test.js` asserts it against an
entry whose `commonMetadata` says one thing and whose work says another.

Sameness is **stricter** than the form's own `isSameValue`, which drops blanks
out of a list before comparing. That is the right answer to "did the user type
something new" and the wrong one to "would removing this change the render":
`directors: [""]` over a work with no directors draws an empty list where the
work draws nothing, and a field of that shape is
`clear_unusable_work_fields.js`'s business, decided on the work rather than on
somebody's entry. Arrays compare element by element in order, because order is
what a list column prints.

### The dry run, 2026-09-14

```
                   keys  removed   real  cleared  entries  objects dropped
filmEntries        2215     1817     54      311      240              147
tvShowEntries      1648     1068    372      181      174                3
gameEntries        3655     2646    214      742      382               19
bookEntries         993      451    267      234      110                0
                   8511     5982    907     1468      906              169
```

5982 keys off 906 entries, 261.1 KB. It reproduces the issue's count exactly,
having arrived at it by a different route. The remaining 154 keys are the ones
on the 23 entries with no work, which is what reconciles `907 + 1468` here
with the `1010 + 1519` above: 103 of those keys are real and 51 are nulls, and
the script does not classify either because it refuses to look.

**169 overrides objects dropped, not 509**, and that reads oddly but is
right: an entry whose every *non-null* override is a no-op still has its
nulls to keep, so the object survives with only the cleared fields in it. 169
is the subset carrying no nulls either.

All 23 skipped entries are "points at no work". Zero dangling `workRef`s,
which agrees with the audit.

### What printing the survivors turned up

**497 of the 907 survivors are `[""]`** — 167 on tv `directors`, 141 on book
`genres`, 46 on film `actors`, and the rest spread over the other list
fields. That is the shape `asOverride`'s own comment names: emptying a list
field used to store `[""]` rather than a null, and this is that bug's backlog
one field over from #317's.

They are out of scope here and deliberately so. `[""]` is not a copy of
anything, so no argument this script makes reaches it, and the strictness
above is what keeps it from being swept up on the way past. But it is now the
more expensive population of the two: `[""]` is non-null, so the merge applies
it, and a field it covers renders empty no matter what the work says. The 167
on tv `directors` sit exactly on top of #328, whose backfill has just given
341 shows the director they were missing — corrected works, blanked at the
row by a value nobody chose.

Worth its own issue, its own argument and its own script. What it is not is a
reason to loosen this one: the whole point of listing survivors rather than
counting them is that a second population shows up as a line you can read
instead of a number you have to trust.

This is only safe *after* #321, which is in production and confirmed: entries
saved since it shipped contribute no no-op overrides at all. Run before it,
this would have cleared a backlog the next save refilled.

## Documents nothing can reach

`scripts/prune_unreachable_documents.js` is two prunes under one roof, because
they make the same claim — the document is there and no code path the site has
can put it in front of a reader — and they are kept apart by `--only` because
the claim is argued differently for each. `--types=` restricts to a work type,
the way `--only=` does everywhere else here. #339.

```
node scripts/prune_unreachable_documents.js --only=works
node scripts/prune_unreachable_documents.js --only=reviews --types=books --list
node scripts/prune_unreachable_documents.js --only=works --apply
```

### Works no entry points at

A work is only ever reached through an entry's `workRef`, so one that no entry
names is unreachable from the site. The dry run of 2026-09-14 found **184**
across the four collections — films 45, tv 10, games 81, books 48 — which is
the figure `audit_database.js` reports under "not problems, for information".
Most are the residue of the hole #174 closed: `/api/works/retrieve` was
unauthenticated and also *wrote*, so walking an API's ids anonymously left a
work document per id.

Two things this does that the audit's count does not.

**It asks every entry collection, not the matching one.** `auditCollection`
reads one works/entries/reviews triple at a time, which is right for a count
and too weak for a delete: nothing in the schema stops a `bookEntries` row
carrying the `_id` of a document in `films`. The run prints how many works
only a foreign collection reaches, zero included — zero is the evidence that
the question was asked. It was zero on 2026-09-14.

**It refuses to touch a work in an open collision group**, and prints the ones
it refused with the group that objected. `title_year_check.js` (#319, #322)
finds one work filed under two ids; `shared_ref_check.js` finds two documents
under one id whose titles agree. Several of those groups are a live document
beside an unreachable one, and the unreachable one is half the evidence for a
decision nobody has made — a prune that took it would settle the question by
destroying it. 18 of the 184 were skipped on that ground: `stalker|1979`,
`mother|2009`, `cure|1997`, `supermetroid|1994`, `control|2019`,
`thewisemansfear|2011` and eleven more. 166 were left to delete.

This half writes only to the work collections, so it needs no exception to the
rule at the top of this file.

### Reviews holding nothing

1,869 review documents hold the empty string — films 741, tv 364, games 306,
books 458, which is 49% of the 3,838 stored. They exist because `createEntry`
writes a review document whenever `review !== undefined` and the entry form
always sends the field.

This half **is** a second exception to "write only to the work collections",
and the argument is narrower than `prune_orphan_reviews.js`'s rather than the
same one again. That script deletes notes no code path can reach: the entry is
gone, and a review is only ever looked up by `entryRef`. This deletes notes a
code path reaches and finds empty.

What makes it safe is not that an empty string is meaningless. It is
deliberately a real value — #213 is the bug that comes of reading an absent
`review` as an instruction to clear one — and the argument is instead that
removing the document is invisible to every reader and to the next save. That
was verified rather than assumed, and the four readers are all of them:

- `updateEntry_` writes `existingReview ? updateByRef_(...) : create_(...)`,
  so the document comes back on the next save whether or not it is there.
- `getReview` answers `{}` for a missing document, which is what the `?.` in
  `review?.data?.text || '*None yet...*'` already turns into the placeholder.
- `findReviews` in `controllers/export.js` filters on `review?.text`, so an
  empty note is left out of an export either way.
- `changedFields` in `utils/revision_history.js` calls `''` and `undefined`
  the same absence, so the version list draws the same history and records no
  version it would not have recorded.

`api/controllers/entries.test.js` pins those, driving the real handler and
comparing a save over an empty note against the same save after a prune.

One difference survives, and it is why this half is a separate flag: `writeForm`
in `frontend/_includes/js/utils/entry_form_io.js` restores a snapshot's note
only `if (snapshot.review !== undefined)`. A version recorded *after* a prune
has no `review` key, so restoring it leaves whatever is in the textarea rather
than emptying it. It takes an entry whose note was empty at the version being
restored and is not empty now, and it changes a restore rather than a save.

Reviews whose *entry* is gone are counted and left alone: they are
`prune_orphan_reviews.js`'s population, and "a save writes it again" is not
available for an entry that no longer exists. There were none on 2026-09-14,
that script having already run.

**Not yet applied.** The dry runs above are what this landed with; both halves
want a fresh snapshot and a human's decision first, and the reviews half in
particular is the repository owner's call.

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

Daily is the cadence the retention policy was written for: "every snapshot
from the last 14 days" assumes there is one most days. The snapshots taken
before an `--apply` are not that — they are the trail of maintenance runs,
and they leave the weeks with no maintenance in them empty.

**Where a scheduled run should live.** The hook is already there:
`MONGODB_URL` is read from the environment and dotenv never overwrites a
variable that is already set, so `MONGODB_URL=... node scripts/backup_database.js
--out=...` runs on a machine with no `.env`, no credentials on disk beyond
what the runner holds, and no checkout of this repo beyond the scripts
themselves. Two things decide where: it has to be **awake on the schedule** —
a laptop that has to be open is not a schedule, which is what the current
snapshot history is a picture of — and its `--out` should not be the same
disk as the code and the `.env`, because the point of a backup is to survive
whatever takes that disk out.

Where it runs is the owner's call and nothing in this repo sets it up. When
it is decided, write it down here: which host, which cadence, where `--out`
points, and who sees it fail. **As of 2026-09-02 the answer is nowhere** —
snapshots are taken by hand before `--apply` runs and at no other time.

**How anyone would notice it had stopped.** A backup job that fails silently
is worse than no job at all, because it buys the confidence of a backup
without the backup. In increasing order of effort:

- Run `scripts/verify_backup.js` immediately after the backup in the same
  scheduled command. It exits non-zero when the snapshot isn't what the
  backup wrote, so the runner's own failure mail becomes the alarm and
  nothing new has to be built.
- `node scripts/backup_database.js --list` prints every snapshot with its
  date, so "when did we last have one" is one command. Cheap, but only
  answers when someone asks.
- A dead-man's switch — a cron-monitoring ping the job sends on success,
  which alerts when it *doesn't* arrive. The only one of the three that fires
  when the machine itself is off, which is exactly the failure the other two
  cannot see.

## Verifying a snapshot

`scripts/verify_backup.js` answers one question: is this snapshot still what
the backup wrote? It is read-only — there is no `--apply` to have — and with
no flags it needs nothing but the files.

```
node scripts/verify_backup.js                       # the newest snapshot
node scripts/verify_backup.js --from=snapshot-2026-08-26T07-27-44-541Z
node scripts/verify_backup.js --live                # also count the database
```

For every collection the manifest lists it checks three things: that the file
is there, that its bytes still hash to the `sha256` the manifest recorded,
and that it parses as a list holding the number of documents the manifest
claims. It prints a table and **exits non-zero if the manifest and the files
disagree**, so it can gate a scheduled backup or a restore drill rather than
being read by eye.

`--live` adds a `countDocuments()` from the database beside each row and a
`drift` column — how far the database has moved since the snapshot. That
needs `MONGODB_URL`, which is why it is behind a flag: without it the check
is a filesystem check and runs anywhere the snapshot does. Drift is never a
failure. The database is *supposed* to have moved on; a drift of zero on a
week-old snapshot would be the surprising result.

```
  collection       manifest   file   sha256   live now   drift
  bookEntries           660    660   ok            660
  entryRevisions         18     18   ok             22      +4
  filmEntries          1528   1528   ok           1531      +3
```

Two things are reported without failing the run: a file sitting in the
snapshot directory that the manifest doesn't list, and a collection the
database has that the snapshot doesn't. Neither breaks a restore — a restore
reads the manifest — but both are worth seeing, the second especially, since
it means a collection created after the snapshot has no backup in it at all.

**Why the `sha256` is the part that matters.** Counts answer "is this the
right *amount* of data"; the digest answers "is this the *same* data". They
are not the same question, and only the second one catches a file that was
re-serialised, hand-edited, half-written or truncated by a filesystem — and
this repo already distrusts the filesystem these snapshots live on (the root
`CLAUDE.md` on Google Drive, and a Drive checkout losing files during
ordinary git operations). A snapshot whose counts match and whose digests
don't is a snapshot you must not restore from.

CLAUDE.md asks for a fresh snapshot to be verified — "manifest counts, file
counts and live `countDocuments()` should agree across every collection" —
immediately before every `--apply`. This is that check, so it stops being
retyped by hand each time:

```
node scripts/backup_database.js && node scripts/verify_backup.js --live
```

The comparison itself lives in `backup_verification.js`, pure and tested;
the script reads, hashes and counts, and prints what comes back. It is the
same rule `restore_backup.js` refuses a bad snapshot with, rather than a
second copy of it — the restore path just takes the cheap half, hashing the
files without parsing them, since all it needs to know before it writes is
whether the bytes changed under it.

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

### The restore drill

A restore that has never been run is a hope, and it is the one script here
whose failure mode would be discovered at the worst possible moment. It also
cannot be rehearsed casually, because rehearsing it means writing. So it gets
rehearsed against a scratch database, on purpose, and the result is recorded
below.

**Never point this at `memo`.** The safety is in the *deployment* the URL
names, not in the database name: every script here calls `client.db("memo")`,
so changing the database in the connection string changes nothing at all —
a restore aimed at the production cluster restores into production whatever
the URI says after the host. Use a deployment that holds nothing you care
about: a local `mongod`, or a throwaway Atlas cluster. And pass
`MONGODB_URL` inline on the command, which beats the `.env` in this folder
(dotenv never overwrites a variable that is already set — see "How a script
finds it"), rather than editing the `.env` and hoping to remember to put it
back.

1. **Verify the snapshot you are about to drill with**, so a failure later is
   the restore's fault and not the snapshot's.

   ```
   node scripts/verify_backup.js
   ```

2. **Point `MONGODB_URL` at the scratch deployment** and confirm what you are
   aimed at before writing anything. An empty database is the clearest start:
   the counts afterwards should equal the manifest's exactly, with nothing to
   subtract.

3. **Restore the whole snapshot into it.** Dry run first — it prints what it
   would write per collection — then apply. `--no-safety-backup` because
   there is nothing in a scratch database worth snapshotting, and taking one
   would drop an empty snapshot into `backups/`.

   ```
   MONGODB_URL=<scratch> node scripts/restore_backup.js --from=<snapshot>
   MONGODB_URL=<scratch> node scripts/restore_backup.js --from=<snapshot> --apply --no-safety-backup
   ```

4. **Check the counts against the manifest**, which is what
   `verify_backup.js --live` does when it is pointed at the scratch database:
   every `drift` cell should be blank, because the database it is now
   counting is the snapshot.

   ```
   MONGODB_URL=<scratch> node scripts/verify_backup.js --from=<snapshot> --live
   ```

5. **Spot-check documents, not just counts.** Counts survive a restore that
   wrote the right number of wrong documents. Pick a few by `_id` — a review
   with a long note is the best one, since a clobbered note is the whole
   reason #78 exists — and compare the text in the database with the text in
   the snapshot's `.json` for that collection.

6. **Exercise `--only`**, because a real incident restores one collection and
   not the database. Delete a handful of documents from one collection in the
   scratch database, then put that collection back:

   ```
   MONGODB_URL=<scratch> node scripts/restore_backup.js --from=<snapshot> --only=bookReviews
   MONGODB_URL=<scratch> node scripts/restore_backup.js --from=<snapshot> --only=bookReviews --apply --no-safety-backup
   ```

   The assertion is in the dry run: it should report exactly the number you
   deleted as "to restore", the rest as unchanged, and nothing at all for the
   other collections.

7. **Record it below**, and drop the scratch database.

Repeat the drill whenever the snapshot format changes — a new field in the
manifest, a different file layout — since that is when a restore silently
stops understanding what it is reading.

**Last drill: 2026-09-16, into a scratch Atlas M0 in its own project.
Passed.** What follows is that drill; the real recovery it was owed after is
recorded beneath it, because the two answer different questions.

Snapshot `snapshot-2026-09-16T06-54-09-686Z`, restored into an empty
deployment — `cluster0.5hmkmzl`, project `memo-restore-drill`, its access list
holding one IP and not `0.0.0.0/0`. Before anything was written the target was
proved to be the target: the host was matched against production's and the
run refused to start if it saw it, and `memo` did not exist on the cluster at
all. Both of `env.js`'s guarantees were leaned on deliberately — a variable
already in the environment always wins over the `.env`, and the local copy has
no `.env` to find — so a production credential could not be picked up.

1. **Full restore.** 14 collections, 9,569 documents, all reported as `to
   restore` and none as `unchanged`, which is what an empty target should say.
2. **Counts.** `verify_backup.js --live` against the scratch cluster: manifest,
   files, `sha256` and live `countDocuments()` agreeing on all 14.
3. **Fidelity, every document rather than a sample.** All 9,569 compared
   against the snapshot's own `.json` files and identical, the longest note
   among them 40,052 characters.
4. **`--only`, against damage of both kinds** — the gap the earlier real
   recovery left. 12 `bookReviews` deleted and 3 overwritten with junk, then
   `--only=bookReviews`: the dry run predicted `12 to restore, 3 to overwrite,
   187 unchanged`, exactly the damage done, and the apply wrote 15. A full
   re-verify afterwards found 0 mismatches across all 9,569, so the
   single-collection restore touched nothing outside its collection.

The scratch project was deleted afterwards and its credential rotated. Do
both: a drill cluster holding a full copy of everyone's entries is a second
production database with none of the attention.

**The real recovery, kept because it answers a different question.**

2026-09-16, recovering from a bad `--apply` rather than rehearsing one. A
one-off dedupe deleted 24 entries, ten of which it should not have: they were
separate seasons filed under one show document and told apart by a title
override, and the script's survivor rule read `status`, `score` and dates
without ever looking at `overrides`. `restore_backup.js
--from=snapshot-2026-09-16T04-24-53-886Z --only=tvShowEntries,tvShowReviews`
put them back.

What it proves: the `--only` path works on production data, the dry run's
counts were exactly right (`14 to restore, 0 to overwrite, 535 unchanged, 0 in
the database but not in the snapshot`), the safety snapshot was taken before
writing, and `tvShowEntries` and `tvShowReviews` came back to 549 and 182 —
their pre-change counts — with no orphaned review and no dangling `workRef`
afterwards. The audit that caught the mistake was re-run and came back clean.

What it did not prove, and what the drill above was therefore run to cover:
this restored two collections out of fourteen, into the deployment the
snapshot came from, against documents that had been deleted rather than
overwritten or corrupted.

The wider lesson is not about the restore. A script that deletes rows should
diff what it is about to delete against what it is keeping, across *every*
field, and refuse when the doomed row holds something the survivor does not —
rather than scoring rows on the fields whoever wrote it happened to think of.
That check existed here only as an audit run afterwards, which is how the
mistake was found rather than prevented.

## Tests

The parts that decide what to write (`work_metadata_merge.js`,
`game_playtime_plan.js`), what to spend an API call on and in what order
(`metadata_refresh_plan.js`), what to delete (`work_dedupe_plan.js`,
`orphan_review_plan.js`, `unreachable_document_plan.js`), what to clear
(`unusable_field_plan.js`, `noop_override_plan.js`), which English edition a misfiled book could be
repointed at (`book_ref_proposal.js`), which snapshots a retention policy
keeps (`backup_plan.js`), whether a snapshot is still what the backup wrote
(`backup_verification.js`) and which indexes are missing (`index_plan.js`)
are pure and dependency-free, and are covered by `node --test`:

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
badly, and is gone too. It can only repair one Google Books still has a
publisher for; `scripts/clear_unusable_work_fields.js` is what removes the
rest, since a merge never clears a field.

Games added between the `howlongtobeat` package's silent death and 2026-08-11
have no playtime at all; `scripts/backfill_game_playtimes.js` fills those.
`mongodb_add_missing_durations.js` did the same job through that package and
went with it.

Games carrying a `duration` with no HowLongToBeat link are reported by the
audit and left alone: no API can add one now, and their playtimes are worth
more than IGDB's replacements would be.

#351 applied the paragraph above to three scripts that had done their job.
`strip_dead_entry_fields.js` unset `review` and `commonMetadata` from entry
documents (#176); #171, fixed by PR #183 on 2026-08-19, is why nothing writes
them any more — `entryUpdateParser` omits `review` and zod drops
`commonMetadata`, so a save cannot put either back, and a dry run finds 0
across all four entry collections. `retype_entry_revisions.js` rewrote
`entryRevisions.entryType` from the url spelling to the document one (#220);
the API has written the document spelling since 2026-08-26 and all 32
revisions are already correct. `repair_shared_refs.js` took another work's id
off the 53 works wearing one (#290); all 25 groups were repaired on
2026-09-03, both guards are in with tests, and the audit reports zero in every
collection.

What each of those had in common is the thing worth checking before deleting
the next one: **the population is zero *and* the cause is fixed in code**. A
script whose population is zero today but whose cause is still live is a
different animal and stays — `prune_orphan_reviews.js` finds no orphan today
and will the first time somebody deletes an entry, and `clear_noop_overrides.js`
found four keys the night after it was applied, written not by a save but by
the refresh crawl correcting a work to match an override that was real when it
was typed. Neither of those is finished; the three above are.

## Taking a dump with the Mongo tools

`scripts/backup_database.js` is enough for our purposes and needs nothing
installed, but `mongodump` produces a BSON dump that `mongorestore`
understands:

```
mongodump --uri="MONGODB_URL_GOES_HERE" --out=./mongobackup
```
