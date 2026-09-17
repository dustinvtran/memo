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

## What enforces it

Not much, and that is worth knowing rather than assuming. The current code
cannot produce a user-named work, but nothing asserts that it never will.

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

## The gap

This is a convention, not an invariant. Nothing in the code says "a work's
title must be what its id answers with", and when it is not, the symptom is
silence: no error, no report, just a document that stops changing.

`audit_database.js --verify-titles` is the closest thing to a check. It
asks each work's id what it names and splits the disagreements —
`titleRefDifferent` for a likely misfiling, `titleRefAlternate` and
`titleRefSpelling` for a name the API also holds (#380). A row that breaks
the rule above will show up there, which is how the 93 were found at all.
Making it an assertion rather than a report is unbuilt.
