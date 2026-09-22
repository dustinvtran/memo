#!/usr/bin/env node
/**
 * @file Removes the `overrides.<field>` keys holding a list with nothing
 * readable in it, and nothing else.
 *
 * An override wins over the work it overlays — `get` in
 * ../../frontend/_includes/js/utils/columns.js merges the two with `??`, and
 * `[""]` is not nullish — so a list whose members are all blank is not an
 * empty cell. It is the work's own directors, actors or studios held off the
 * page for ever, under an anchor with no text and no destination. `Gilmore
 * Girls: Season 1` has `directors: ["Amy Sherman-Palladino"]` on its work and
 * shows no director at all. These are also the anchors with no accessible
 * name that axe reports as `link-name`, which #423 named and left — naming a
 * decorative glyph is a different repair from putting a work's own value back
 * on a row. This is the write half of #395; ../blank_override_check.js and
 * `audit_database.js` are the read half, which shipped in #409.
 *
 * **Which of them a run actually reaches, since #395's own comment gets this
 * wrong.** That comment attributes the books list's unnamed links to blank
 * `genres`; `genres` is not a books column at all — see the type's `columns`
 * in ../../frontend/_includes/js/utils/conversions.js, which draws Authors and
 * not Genres, and `visible: false` on the genre column everywhere else. The
 * two unnamed links on that page are blank `authors`, and **both sit on
 * entries with no work, so this script skips them and the books list keeps
 * them.** The accessibility win is on the lists whose linked column is
 * visible by default and whose rows have a work underneath: tv and films
 * Director, games Studios. Measured on 2026-09-21, blank keys in those three
 * columns are 164 tv `directors`, 6 film `directors` and 33 game `studios`,
 * of which a run clears 164, 3 and 31 — the remainder being entries with no
 * work. Only one account's rows are on any one page, so a per-page count is
 * smaller than these: 161 of the tv keys are the owner's and 3 another
 * account's.
 *
 * **The code that wrote these is already fixed.** `asOverride` in
 * ../../frontend/_includes/js/utils/entry_form_io.js treats a list of blanks
 * as blank and stores a `null` or nothing at all, and its docstring names this
 * exact population — "which is what put `[""]` on the `directors` of 538 TV
 * shows". So this is that bug's backlog, and the only thing that has reduced
 * it is entries happening to be re-saved. Running it now settles the question
 * rather than clearing a backlog the next save refills.
 *
 * **This writes to `*Entries`, which ../../../CLAUDE.md reserves.** That rule
 * exists to keep a maintenance script away from the text people typed, which
 * lives on the entry documents, and this script's entire job is to touch that
 * object — so the exception is argued rather than assumed, the way
 * ./clear_noop_overrides.js and ./link_entry.js argue their own.
 *
 * The argument has three parts, and each is a claim a reader can check:
 *
 * - **Removing the key restores the work's own value to the page**, which is
 *   the outcome in every case. Both merges — the row builder in
 *   ../../frontend/_includes/js/components/list/list.js and `withOverrides` in
 *   ../../api/utils/export_view.js — fall through to the work the moment the
 *   override stops being nullish. That is the whole effect: 219 rows that draw
 *   an empty cell over a value the database holds start drawing it.
 * - **`$unset` of a key whose value is a list of blanks destroys no user
 *   text, because there is none.** Every member is empty or whitespace. There
 *   is nothing in it a person can have typed, and no state it could be
 *   expressing — the form's way of saying "the work's value is wrong and there
 *   is no replacement" is a `null`, which this never touches.
 * - **A restore from the snapshot undoes it.** ./restore_backup.js matches on
 *   `_id`, and every write here is an `$unset` on a document that keeps its
 *   `_id`, so a run is reversible field for field from the snapshot taken
 *   immediately before it. Nothing here creates, deletes or repoints a
 *   document, so there is no shape a restore could not put back.
 *
 * **../noop_override_plan.js:185 is deliberately stricter, and is right to
 * be.** It compares an override against the work byte for byte and keeps
 * anything different, so `[""]` against `["Amy Sherman-Palladino"]` is a real
 * override to it and always will be. An empty override is not a no-op
 * override, it is a wrong one, and the two need different arguments — which is
 * why this is a separate script rather than a loosened comparison in that one.
 * Loosening it would also destroy the line in its output that found this
 * population: 497 of the 907 survivors it printed on 2026-09-14 were `[""]`.
 *
 * What bounds it, since the collection it writes to is the one holding
 * everything a person typed:
 *
 * - It only ever `$unset`s `overrides.<field>` keys it has classified, one key
 *   at a time, and removes the `overrides` object itself only when the removal
 *   accounted for every key in it. `status`, `score`, the dates, `workRef` and
 *   the note are unreachable from here, and an `$unset` can neither create,
 *   delete nor repoint a document. `unsetPaths` in ../blank_override_plan.js is
 *   where that is decided, so it is covered by the no-install suite.
 * - **A `null` is never touched**, for the reason above. It is the easiest
 *   thing here to get wrong and the only one that loses a decision silently.
 * - **A list with any non-blank member is never touched**, whatever else is in
 *   it: `["", "Christopher Nolan"]` renders Nolan. Every survivor is printed
 *   with the work's value beside it rather than left as a count.
 * - **A key whose own name `overrides.<field>` cannot address is refused**, to
 *   stderr and with a non-zero exit. A field holding a `.` would name
 *   something nested and one starting with `$` would read as an operator, so
 *   there is no path that reaches it one key at a time. MongoDB has allowed
 *   both in a stored document since 5.0; nothing the site writes is one, which
 *   is why a line there is news rather than a footnote.
 * - **An entry with no readable work is skipped entirely**, both the
 *   hand-typed entries that point at no work and any dangling `workRef`. For
 *   those, `overrides` is not a layer over the metadata, it *is* the metadata,
 *   so there is nothing underneath for a removal to reveal.
 * - The comparison is against the work document, never against
 *   `commonMetadata`, which has the overrides folded into it already. The plan
 *   is handed the works and joins them itself, so there is no call site that
 *   could pass the wrong baseline.
 * - **It never touches `updatedDate`.** A write that bumped it would reorder
 *   every list on the site, which is a visible change to data nobody asked to
 *   change. The plan emits no `$set` at all.
 * - It re-reads the collection afterwards and reports the entry count, so a
 *   run that did something other than what it planned says so.
 *
 * Adding this exception to the list in ../README.md is a human's call, as is
 * the `--apply`. Take a snapshot with ./backup_database.js and verify it with
 * `./verify_backup.js --live` first, per ../../../CLAUDE.md; this script also
 * dumps each entry collection it is about to write to.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/clear_blank_overrides.js
 *   node scripts/clear_blank_overrides.js --only=tv --masking-only
 *   node scripts/clear_blank_overrides.js --apply
 *
 * Flags:
 *   --apply             actually unset (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --masking-only      only the keys hiding a value the work really has,
 *                       leaving the ones that hide nothing yet
 *   --show-kept=n       how many surviving overrides to print per collection
 *                       (default 40, `--show-kept=all` for every one)
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put the pre-run backups (default ../backups)
 */
require("../env");
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  selectCollections,
  parseArgs,
} = require("../work_collections");
const {
  planBlankOverrideRemoval,
  unsetPaths,
} = require("../blank_override_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  maskingOnly: args["masking-only"] === true,
  showKept:
    args["show-kept"] === undefined
      ? 40
      : args["show-kept"] === "all"
      ? Infinity
      : Number(args["show-kept"]),
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

let client;

const main = async () => {
  const selected = selectCollections(args.only);
  if (selected.length === 0) {
    console.error(
      `--only=${args.only} matched nothing. Valid types: ${COLLECTIONS.map(
        (c) => c.type
      ).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? "APPLY MODE: empty override list keys will be unset from entry documents."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );
  if (options.maskingOnly) {
    console.log(
      "--masking-only: leaving the keys that hide nothing yet, which are " +
        "still wrong and start masking the moment a refresh fills the field."
    );
  }

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  let blocked = false;
  for (const collection of selected) {
    const result = await clearCollection(db, collection);
    report[collection.type] = result;
    if (result.blocked) blocked = true;
  }

  summarise(report);

  if (blocked) {
    console.error(
      "\nOne or more collections were refused. Nothing was written for those. " +
        "This means a works collection came back empty beside entries that " +
        "point at it, which is what a failed read looks like — check the " +
        "connection before re-running."
    );
    process.exitCode = 1;
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const clearCollection = async (db, collection) => {
  console.log(`\n=== ${collection.entries} ===`);

  const entries = await db.collection(collection.entries).find().toArray();
  const works = await db.collection(collection.works).find().toArray();

  const plan = planBlankOverrideRemoval(entries, works, {
    maskingOnly: options.maskingOnly,
  });

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  const { totals } = plan;
  console.log(
    `  ${totals.entries} entries, ${totals.withOverrides} carrying overrides, ` +
      `${totals.keys} override key(s) between them`
  );
  console.log(
    `  ${totals.blankKeys} key(s) hold a list with nothing readable in it: ` +
      `${totals.maskingKeys} hiding the work's own value, ` +
      `${totals.harmlessKeys} hiding nothing yet, ` +
      `${totals.skippedBlankKeys} on an entry with no work to compare`
  );
  console.log(
    `  ${totals.removed} key(s) ` +
      `${options.apply ? "removed" : "would be removed"} from ` +
      `${totals.entriesTouched} entry(s), ${totals.maskedRows} of which are ` +
      `rows a reader sees as empty today; ` +
      `${totals.objectsDropped} of those entries have nothing else in the ` +
      `object`
  );

  printRemovalsByField(plan);
  printRemovals(plan);
  printKept(plan, collection);

  const base = {
    entries: totals.entries,
    withOverrides: totals.withOverrides,
    keys: totals.keys,
    blankKeys: totals.blankKeys,
    maskingKeys: totals.maskingKeys,
    harmlessKeys: totals.harmlessKeys,
    removed: totals.removed,
    heldBack: totals.heldBack,
    real: totals.real,
    cleared: totals.cleared,
    unaddressable: totals.unaddressable,
    skippedEntries: totals.skippedEntries,
    skippedKeys: totals.skippedKeys,
    skippedBlankKeys: totals.skippedBlankKeys,
    entriesTouched: totals.entriesTouched,
    maskedRows: totals.maskedRows,
    objectsDropped: totals.objectsDropped,
    byField: plan.byField,
    removals: plan.removals.map((removal) => ({
      _id: String(removal._id),
      dropsObject: removal.dropsObject,
      unset: Object.keys(unsetPaths(removal)),
      fields: removal.fields.map((field) => ({
        field: field.field,
        stored: field.stored,
        workValue: field.workValue ?? null,
        masks: field.masks,
      })),
    })),
    kept: plan.kept.real.map((kept) => ({ ...kept, _id: String(kept._id) })),
    heldBackKeys: plan.kept.heldBack.map((held) => ({
      ...held,
      _id: String(held._id),
    })),
    unaddressableKeys: plan.kept.unaddressable.map((kept) => ({
      ...kept,
      _id: String(kept._id),
    })),
    skipped: plan.kept.skipped.map((skipped) => ({
      ...skipped,
      _id: String(skipped._id),
      workRef: skipped.workRef === undefined ? null : String(skipped.workRef),
    })),
  };

  if (!options.apply || plan.removals.length === 0) {
    return { ...base, unset: { keys: 0, entries: 0 } };
  }

  backup(collection.entries, entries);

  const unset = await applyRemovals(db, collection, plan);
  const remaining = await countRemaining(db, collection);

  console.log(
    `  after: ${remaining.entries} entries (was ${totals.entries}), ` +
      `${remaining.withOverrides} still carrying an overrides object`
  );

  if (remaining.entries !== totals.entries) {
    console.error(
      `  ENTRY COUNT CHANGED: ${totals.entries} -> ${remaining.entries}. ` +
        `Restore from the snapshot taken before this run.`
    );
    process.exitCode = 1;
  }

  return { ...base, unset, remaining };
};

/**
 * One `bulkWrite` of per-document `$unset`s, rather than the single
 * `updateMany` a named field would allow: each entry has its own list of keys,
 * so the operation genuinely differs document by document. `$unset` and not
 * `$set: null` — a null is a stored field, and on `overrides` it is
 * specifically the one value that means something. The paths come from
 * ../blank_override_plan.js so that what is written is decided in the module
 * the suite tests, not here.
 */
const applyRemovals = async (db, collection, plan) => {
  const operations = plan.removals.map((removal) => ({
    updateOne: {
      filter: { _id: removal._id },
      update: { $unset: unsetPaths(removal) },
    },
  }));

  const result = await db
    .collection(collection.entries)
    .bulkWrite(operations, { ordered: false });

  console.log(
    `  unset ${plan.totals.removed} key(s) from ${result.modifiedCount} entry(s)`
  );
  if (result.modifiedCount !== plan.removals.length) {
    console.error(
      `  expected ${plan.removals.length}, modified ${result.modifiedCount} — ` +
        `something else is writing to ${collection.entries}.`
    );
    process.exitCode = 1;
  }
  return { keys: plan.totals.removed, entries: result.modifiedCount };
};

/**
 * What is going, by field, with what survives beside it for context.
 *
 * The first three columns are the audit's own three, in its own words, and
 * they add up to the key count it prints for that field — `masking` and
 * `undecided` are `../blank_override_check.js`'s numbers rather than a second
 * calculation of them. Reconciling the report that found this against the run
 * that clears it is the one check anyone can do from the outside, so the
 * columns are arranged to make it possible rather than to read tidily.
 */
const printRemovalsByField = (plan) => {
  const fields = Object.entries(plan.byField).sort(
    ([, a], [, b]) => b.removed - a.removed
  );
  if (fields.length === 0) return;

  console.log(
    `\n  by field (masking / hides nothing / no work = the audit's keys; ` +
      `then removed / real / null):`
  );
  for (const [field, counts] of fields) {
    console.log(
      `      ${field.padEnd(24)} ${String(counts.masking).padStart(7)} ` +
        `${String(counts.harmless).padStart(14)} ` +
        `${String(counts.undecided).padStart(8)} ` +
        `${String(counts.removed).padStart(10)} ` +
        `${String(counts.real).padStart(6)} ` +
        `${String(counts.cleared).padStart(6)}`
    );
  }
};

/**
 * Every removal, with the work's value beside it. A dry run of this is what a
 * person authorises, and the claim being authorised is "the work has the
 * answer and this key is hiding it" — one row per key, so that claim can be
 * read rather than taken on the strength of a total.
 */
const printRemovals = (plan) => {
  const masking = plan.removals.flatMap((removal) =>
    removal.fields
      .filter((field) => field.masks)
      .map((field) => ({ _id: removal._id, ...field }))
  );
  if (masking.length === 0) return;

  console.log(
    `\n  ${masking.length} key(s) hiding the work's own value — the stored ` +
      `override, then what the row would show instead:`
  );
  for (const hidden of masking.slice(0, options.showKept)) {
    console.log(
      `      ${hidden._id} ${hidden.field}: ${short(hidden.stored)} ` +
        `-> ${short(hidden.workValue)}`
    );
  }
  if (masking.length > options.showKept) {
    console.log(
      `      ... and ${masking.length - options.showKept} more; ` +
        `--show-kept=all or --json=path for the rest`
    );
  }
};

/**
 * Everything the run is leaving behind, printed rather than implied. A count
 * of survivors is the one number nobody can check afterwards, so the real
 * overrides are listed with the work's value beside them: that is the line
 * that shows a decision was a decision.
 */
const printKept = (plan, collection) => {
  const { real, heldBack, unaddressable, skipped } = plan.kept;

  if (real.length > 0) {
    console.log(
      `\n  ${real.length} real override(s) LEFT ALONE — the user's value, ` +
        `then the work's:`
    );
    for (const kept of real.slice(0, options.showKept)) {
      console.log(
        `      ${kept._id} ${kept.field}: ${short(kept.stored)} ` +
          `(work: ${short(kept.workValue)}) — ${kept.reason}`
      );
    }
    if (real.length > options.showKept) {
      console.log(
        `      ... and ${real.length - options.showKept} more; ` +
          `--show-kept=all or --json=path for the rest`
      );
    }
  }

  if (plan.totals.cleared > 0) {
    console.log(
      `\n  ${plan.totals.cleared} cleared field(s) LEFT ALONE — a null is a ` +
        `field the user emptied on purpose, not a blank list.`
    );
  }

  // Expected to be empty, which is why it is printed rather than counted:
  // nothing the site writes has a name like this, so a line here is news.
  if (unaddressable.length > 0) {
    console.error(
      `\n  ${unaddressable.length} key(s) REFUSED — the key's own name is ` +
        `not addressable as an overrides.<field> path, so no $unset could ` +
        `name just that key:`
    );
    for (const kept of unaddressable) {
      console.error(
        `      ${kept._id} ${JSON.stringify(kept.field)}: ${short(kept.stored)}`
      );
    }
  }

  if (heldBack.length > 0) {
    console.log(
      `\n  ${heldBack.length} blank key(s) HELD BACK by --masking-only — ` +
        `each one is still wrong, and starts masking the moment a refresh ` +
        `fills the field on the work:`
    );
    for (const held of heldBack.slice(0, options.showKept)) {
      console.log(`      ${held._id} ${held.field}: ${short(held.stored)}`);
    }
    if (heldBack.length > options.showKept) {
      console.log(
        `      ... and ${heldBack.length - options.showKept} more`
      );
    }
  }

  if (skipped.length > 0) {
    console.log(
      `\n  ${skipped.length} entry(s) SKIPPED ENTIRELY ` +
        `(${plan.totals.skippedKeys} key(s), ` +
        `${plan.totals.skippedBlankKeys} of them blank lists) — no work to ` +
        `compare against, so their overrides are the only metadata they have:`
    );
    for (const entry of skipped) {
      console.log(
        `      ${entry._id}: ${entry.reason} (${entry.fields.length} key(s), ` +
          `blank: ${entry.blankFields.join(", ") || "none"})`
      );
    }
    const dangling = skipped.filter((e) => e.reason.includes("gone"));
    if (dangling.length > 0) {
      console.error(
        `  ${dangling.length} of those are dangling workRefs in ` +
          `${collection.entries}, which the audit should not be finding. ` +
          `Worth chasing separately.`
      );
    }
  }
};

/** What is left, asked of the database rather than inferred from the plan. */
const countRemaining = async (db, collection) => {
  const entriesCollection = db.collection(collection.entries);
  return {
    entries: await entriesCollection.countDocuments(),
    withOverrides: await entriesCollection.countDocuments({
      overrides: { $exists: true },
    }),
  };
};

const summarise = (report) => {
  const totals = Object.values(report).reduce(
    (sum, r) => ({
      blankKeys: sum.blankKeys + (r.blankKeys ?? 0),
      removed: sum.removed + (r.removed ?? 0),
      heldBack: sum.heldBack + (r.heldBack ?? 0),
      maskedRows: sum.maskedRows + (r.maskedRows ?? 0),
      real: sum.real + (r.real ?? 0),
      cleared: sum.cleared + (r.cleared ?? 0),
      unaddressable: sum.unaddressable + (r.unaddressable ?? 0),
      entriesTouched: sum.entriesTouched + (r.entriesTouched ?? 0),
      objectsDropped: sum.objectsDropped + (r.objectsDropped ?? 0),
      skippedEntries: sum.skippedEntries + (r.skippedEntries ?? 0),
    }),
    {
      blankKeys: 0,
      removed: 0,
      heldBack: 0,
      maskedRows: 0,
      real: 0,
      cleared: 0,
      unaddressable: 0,
      entriesTouched: 0,
      objectsDropped: 0,
      skippedEntries: 0,
    }
  );

  console.log(
    `\n${totals.removed} of ${totals.blankKeys} blank override key(s) ` +
      `${options.apply ? "removed" : "would be removed"} from ` +
      `${totals.entriesTouched} entry(s); ${totals.maskedRows} of those are ` +
      `rows showing a reader an empty cell over a value the database holds. ` +
      `${totals.objectsDropped} overrides object(s) emptied and dropped.`
  );
  if (totals.heldBack > 0) {
    console.log(
      `${totals.heldBack} blank key(s) held back by --masking-only.`
    );
  }
  console.log(
    `${totals.real} real override(s) and ${totals.cleared} cleared field(s) ` +
      `left alone, plus every key on ${totals.skippedEntries} entry(s) with ` +
      `no work to compare against.`
  );
  if (totals.unaddressable > 0) {
    console.error(
      `${totals.unaddressable} key(s) refused for a name no ` +
        `overrides.<field> path can reach. Nothing the site writes looks ` +
        `like that — worth chasing before deciding what to do about them.`
    );
    process.exitCode = 1;
  }
};

/**
 * A value at a length a terminal can hold, and never more than one line.
 *
 * A list is printed with its elements quoted rather than joined, because
 * `[""]` and `[]` and a missing field join to the same empty string and they
 * are three different things — and here the difference between them is the
 * difference between a key this removes and two it does not.
 */
const short = (value) => {
  const text = Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : value === undefined
    ? "(absent)"
    : value === null
    ? "null"
    : typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
};

const backup = (collectionName, documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${collectionName}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`  backed up ${documents.length} document(s) to ${file}`);
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
