#!/usr/bin/env node
/**
 * @file Removes the overrides that are byte-identical copies of the work they
 * override, and nothing else.
 *
 * Until #321, `readForm` compared the add/edit form against `data.apiData`, a
 * name nothing in the frontend sets, so every field came back different and
 * every save wrote the whole form back as the user's overrides. Measured on
 * 2026-09-14, 5982 of the 8511 override keys in production — seventy per cent
 * of everything stored — hold the value they are overriding, and 509 entries
 * have nothing else in their overrides object at all. The code half is fixed
 * and confirmed in production; this is that bug's backlog. #317.
 *
 * **This writes to `*Entries`, which ../../../CLAUDE.md reserves.** That rule
 * exists to keep a maintenance script away from the user overrides that live
 * there, and this script's entire job is to touch them, so the exception is
 * argued rather than assumed — the way ./prune_orphan_reviews.js argues its
 * own, and one field narrower than ./strip_dead_entry_fields.js.
 *
 * The argument is that an override holding the work's own value is not a user
 * decision. Nobody typed it: it is the artefact of a comparison against
 * `undefined`, and the entry's own history says so — the form read the work,
 * sent it back, and the save stored nine fields as nine decisions. Removing
 * one changes nothing a reader sees, because the row builder in
 * ../../frontend/_includes/js/components/list/list.js and `withOverrides` in
 * ../../api/utils/export_view.js both merge the override over the work and
 * produce the identical value either way. What it changes is that a
 * correction to the work can reach the page again instead of losing to a
 * stale copy of the value it corrected.
 *
 * What bounds it, since the collection it writes to is the one holding
 * everything a person typed:
 *
 * - It only ever `$unset`s `overrides.<field>` keys it has compared, one key
 *   at a time, and removes the `overrides` object itself only when the
 *   comparison accounted for every key in it. `status`, `score`, the dates,
 *   `workRef` and the note are unreachable from here, and an `$unset` can
 *   neither create, delete nor repoint a document.
 * - **A `null` is never touched.** It is the form's way of saying "the work's
 *   value is wrong and there is no replacement", so removing it would
 *   un-clear a field somebody deliberately cleared. 1519 of the keys are
 *   these, and every one survives a run.
 * - **A different value is never touched**, and every one of them is printed
 *   rather than implied, so the 1010 real overrides are visible in the output
 *   beside what is going.
 * - **An entry with no readable work is skipped entirely.** The 23 hand-typed
 *   entries that point at no work render from `overrides` over an empty
 *   stand-in, so for them it is not a layer over the metadata, it is the
 *   metadata. A dangling `workRef` is skipped for the same reason.
 * - The comparison is against the work document. Never against
 *   `commonMetadata`, which has the overrides folded into it already — see
 *   ../noop_override_plan.js, which is handed the works and joins them itself
 *   so there is no call site that could pass the wrong baseline.
 * - It never touches `updatedDate`. A write that bumped it would reorder
 *   every list on the site, which is a visible change to data nobody asked to
 *   change.
 *
 * Running it before #321 shipped would have been pointless — the next save
 * put them all back. It shipped, and entries saved since carry zero no-op
 * overrides, so this clears the backlog and settles the question with it.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/clear_noop_overrides.js
 *   node scripts/clear_noop_overrides.js --only=games
 *   node scripts/clear_noop_overrides.js --apply
 *
 * Flags:
 *   --apply             actually unset (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
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
const { planNoopOverrideRemoval } = require("../noop_override_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
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
      ? "APPLY MODE: no-op override keys will be unset from entry documents."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

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

  const plan = planNoopOverrideRemoval(entries, works);

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
    `  ${totals.removed} key(s) hold the work's own value ` +
      `(${toKb(totals.jsonChars)}), on ${totals.entriesTouched} entry(s); ` +
      `${totals.objectsDropped} of those have nothing else in the object`
  );

  printRemovalsByField(plan);
  printKept(plan, collection);

  const base = {
    entries: totals.entries,
    withOverrides: totals.withOverrides,
    keys: totals.keys,
    removed: totals.removed,
    real: totals.real,
    cleared: totals.cleared,
    skippedEntries: totals.skippedEntries,
    skippedKeys: totals.skippedKeys,
    entriesTouched: totals.entriesTouched,
    objectsDropped: totals.objectsDropped,
    jsonChars: totals.jsonChars,
    byField: plan.byField,
    removals: plan.removals.map((removal) => ({
      _id: String(removal._id),
      fields: removal.fields,
      dropsObject: removal.dropsObject,
    })),
    kept: plan.kept.real.map((kept) => ({ ...kept, _id: String(kept._id) })),
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
 * One `bulkWrite` of per-document `$unset`s, rather than the two `updateMany`s
 * ./strip_dead_entry_fields.js gets away with: there the same field comes off
 * every entry in a set, here each entry has its own list of keys, so the
 * operation genuinely differs document by document. `$unset` and not
 * `$set: null` — a null is a stored field, and on `overrides` it is
 * specifically the one value that means something.
 */
const applyRemovals = async (db, collection, plan) => {
  const operations = plan.removals.map((removal) => ({
    updateOne: {
      filter: { _id: removal._id },
      update: {
        $unset: removal.dropsObject
          ? { overrides: "" }
          : Object.fromEntries(
              removal.fields.map((field) => [`overrides.${field}`, ""])
            ),
      },
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

/** What is going, by field, with what survives beside it for context. */
const printRemovalsByField = (plan) => {
  const fields = Object.entries(plan.byField).sort(
    ([, a], [, b]) => b.removed - a.removed
  );
  if (fields.length === 0) return;

  console.log(`\n  by field (removed / real / cleared):`);
  for (const [field, counts] of fields) {
    console.log(
      `      ${field.padEnd(24)} ${String(counts.removed).padStart(5)} ` +
        `${String(counts.real).padStart(6)} ${String(counts.cleared).padStart(8)}`
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
  const { real, skipped } = plan.kept;

  if (real.length > 0) {
    console.log(
      `\n  ${real.length} real override(s) LEFT ALONE — the user's value, ` +
        `then the work's:`
    );
    for (const kept of real.slice(0, options.showKept)) {
      console.log(
        `      ${kept._id} ${kept.field}: ${short(kept.stored)} ` +
          `(work: ${short(kept.workValue)})`
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
        `field the user emptied on purpose, not a copy.`
    );
  }

  if (skipped.length > 0) {
    console.log(
      `\n  ${skipped.length} entry(s) SKIPPED ENTIRELY ` +
        `(${plan.totals.skippedKeys} key(s)) — no work to compare against, ` +
        `so their overrides are the only metadata they have:`
    );
    for (const entry of skipped) {
      console.log(
        `      ${entry._id}: ${entry.reason} (${entry.fields.length} key(s))`
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
      removed: sum.removed + (r.removed ?? 0),
      real: sum.real + (r.real ?? 0),
      cleared: sum.cleared + (r.cleared ?? 0),
      entriesTouched: sum.entriesTouched + (r.entriesTouched ?? 0),
      objectsDropped: sum.objectsDropped + (r.objectsDropped ?? 0),
      skippedEntries: sum.skippedEntries + (r.skippedEntries ?? 0),
      chars: sum.chars + (r.jsonChars ?? 0),
    }),
    {
      removed: 0,
      real: 0,
      cleared: 0,
      entriesTouched: 0,
      objectsDropped: 0,
      skippedEntries: 0,
      chars: 0,
    }
  );

  console.log(
    `\n${totals.removed} no-op override key(s) ` +
      `${options.apply ? "removed" : "would be removed"} from ` +
      `${totals.entriesTouched} entry(s), ${toKb(totals.chars)} in all; ` +
      `${totals.objectsDropped} overrides object(s) emptied and dropped.`
  );
  console.log(
    `${totals.real} real override(s) and ${totals.cleared} cleared field(s) ` +
      `left alone, plus every key on ${totals.skippedEntries} entry(s) with ` +
      `no work to compare against.`
  );
};

/**
 * A value at a length a terminal can hold, and never more than one line.
 *
 * A list is printed with its elements quoted rather than joined, because
 * `[""]` and `[]` and a missing field join to the same empty string and they
 * are three different things — and `[""]` is not a rarity here. It is what
 * emptying a list field used to store instead of a null, and it accounts for
 * 497 of the 907 overrides a run leaves behind. Printing survivors is the
 * whole reason a reader can check what was kept; printing them ambiguously
 * would be worse than a count, which at least does not mislead.
 */
const short = (value) => {
  const text = Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : value === undefined
    ? "(absent)"
    : value === null
    ? "null"
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

const toKb = (chars) => `${(chars / 1024).toFixed(1)} KB`;

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
