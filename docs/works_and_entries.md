# Works and entries

Every row on a list is two documents. A **work** is the database's copy of
what an external API says about a thing — title, year, runtime, cast,
cover. An **entry** is one person's row about it: status, score, dates,
and a review beside it.

The rule between them is one sentence, and the rest of this file is why it
matters and what happens when a row breaks it.

> A work is read-only from the user's side. What a person types lives on
> their entry, in `overrides`, and is laid over the work when the row is
> rendered.

## What that buys

A work can always refresh. `backfill_work_metadata.js` re-asks the API for
every work on a schedule, and because nothing a person typed is stored
there, a refresh can overwrite the whole document without asking anybody
and without losing anything. The overrides sit on the entry and keep
overriding whatever the work becomes.

That is the entire reason for the split. A season named `Ozark: Season 4`,
a DLC named `Nioh 2 DLC: The First Samurai`, a film you know as
`Matrix 4: Resurrections` — all of them are one work at the show's or
game's or film's own id, and the name is on the entry. The work stays
TMDB's `Ozark`, refreshing forever, and your list still reads
`Ozark: Season 4`.

**An override never changes what a work is linked to.** `apiRefs` is the
work's identity and nothing on an entry touches it. Renaming a row on your
list does not re-point it at a different film.

## One entry per name, and where a second viewing goes

A person may have **one entry per work per name**. `alreadyListed` in
`src/api/controllers/entries.js` refuses a save when the same user already
has an entry on the same `workRef` under the same `filedAs` — the override
if there is one, the work's own title if not — and #360 closed the update
path as well as the create path, so a rename onto a sibling's name is
refused too.

That rule is what makes seasons work. `Castlevania: Season 1` and
`Castlevania: Season 2` are two entries on one work, told apart by the name
on each, and neither is a duplicate of the other.

**It also means a re-viewing cannot be a second entry under the same name.**
Watching a season again, or replaying a game, has two homes and the choice
is the owner's:

- **In the existing entry's note**, which is where it usually goes. One row,
  one score — the latest opinion — and the prose carries the history. A
  `Castlevania: Season 1` entry whose note ends "In July 2021, I ended up
  rewatching the whole season and not recognizing that I had already watched
  the season!" is exactly this, and there is no second row for that viewing.
- **As its own entry under a distinct name**, when the two viewings deserve
  separate dates and scores. The name has to differ or the save is refused.

Do not read a second entry on a work as a duplicate to be merged, and do not
read a note mentioning a rewatch as evidence that some other row *is* that
rewatch. A rewatch recorded in prose has no row at all, and a maintenance
script that assumes otherwise will delete a real one. That has happened.

## What enforces it

Four things hold it up, and `src/api/controllers/work_is_read_only.test.js`
asserts each of them against the real handlers rather than by reading the
source — a test that greps for `updateOne` passes happily while a fifth code
path writes a work some other way.

- **`/api/works` is GET-only.** `src/api/routes/works.js` routes exactly
  two things, `search` and `retrieve`. There is no route that writes a
  work's metadata, so no form can post one.
- **The one work-write from the site stores what the API answered.**
  `createWork` in `src/api/controllers/works.js` calls `db.create_` with
  the retrieve result unmodified. It fires when somebody links an entry to
  a ref the database does not hold yet.
- **Saving an entry never writes a work.** `src/api/controllers/entries.js`
  reads one through `workFor` — to validate against, never to update — and
  the form computes `differencesFrom(work)` and stores the difference as
  `entry.overrides`.
- **Both places that write a work's title write the API's own spelling.**
  `refUpdate` in `work_ref_repair.js` and `workTitleUpdate` in
  `entry_link_plan.js` each set `displayTitle(retrieved)`, never the text
  that was typed into the plan. Those are maintenance scripts, and even
  there the API's answer is the only thing that reaches the document.

## What goes wrong when a row is the other way round

Nothing visible, which is the problem.

`mergeWork`'s title guard (#290) refuses to merge an API response whose
title disagrees with the stored one, because a disagreement usually means
the work is filed under another thing's id and overwriting it would put one
film's data in another film's record. The guard is right and it is the
reason #290 is not still happening.

But it cannot tell "wrong id" from "right id, my own name for it". So a
work carrying a person's name is refused **every time, forever**. It never
refreshes again, and the only trace is a line in a backfill log that nobody
reads.

#381 found 93 of them — a third of everything due — and almost none was
damaged. `Ozark: Season 4` under Ozark's id. `House M.D.` under *House*'s.
`Salo` under *Salò, or the 120 Days of Sodom*. Some had been frozen for
years. The tv half of the population was even reported by the audit as
`expectedSharedRefs`, "separate seasons, expected" — expected, and not
free.

## Repairing a row that is the wrong way round

`scripts/link_entry.js` takes `workTitle` on a `link`, `move` or `retitle`.
It renames the work to the API's own title and clears
`metadataUpdatedDate`, so the next backfill fills everything the freeze kept
out.

```json
{ "op": "retitle", "type": "tv", "entry": "<id>", "toWork": "<id>",
  "entryTitle": "Ozark: Season 4", "workTitle": "Ozark" }
```

Two things about it are deliberate.

**It is refused without an `entryTitle`.** Renaming the work on its own
buys the refresh by leaving the name somebody typed written down nowhere,
which is not a repair. The two writes go together so a row cannot be left
half done.

`entryTitle` is three-valued here as everywhere else, and the difference
between two of those values is the guard: **absent** means nobody
considered the old name, which is refused; **empty** means somebody looked
and said to drop it, which is theirs to say. A work filed as `The Witcher`
under The Witcher IV's id is the second — the id is right and the name is
merely stale.

**`workTitle` is checked against the retrieve**, the same way
`retitleWorkTo` is in `work_ref_repair.js`. Naming the API's own title is
something you can only do having read it, and it is what tells "right id,
my own name for it" from a genuinely misfiled id. The misfiled ones are the
other population wearing the same refusal, and they want `replacesRef`
(#379) instead — a different repair, because there the id is what is wrong.

## Catching a row that breaks the rule

The tests above stop the *code* from breaking the rule. They cannot stop a
*document* from being in a state that breaks it, and that state is the one
whose symptom is silence — no error, no report, just a work that stops
changing.

Two things look for it.

`backfill_work_metadata.js --fail-on-refusal` exits non-zero when any work
in the slice could not be refreshed. Without the flag a refusal is printed
and the run still exits 0, which is exactly how 93 of them accumulated: the
nightly job was green every night for years. It is off by default because a
refusal is a fact about the data rather than a fault in the run, and this
script is also how somebody looks at a slice.

`audit_database.js --verify-titles` asks each work's id what it names and
splits the disagreements: `titleRefDifferent` for a likely misfiling,
`titleRefAlternate` and `titleRefSpelling` for a name the API also holds
(#380). It costs a call per work, which is why it is a flag and not the
default.

**The nightly refresh does not pass `--fail-on-refusal` yet.** Films, tv and
games are at zero refusals; books are not, so turning it on in
`.github/workflows/refresh_metadata.yml` would make the job red on its next
firing for a population nobody has triaged. Turning it on is the last step,
and it wants those books looked at first.
