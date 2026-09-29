#!/usr/bin/env node
/**
 * @file Removes every `null` override key, and the overrides object with them
 * when nothing else is in it; and reports, on the way, the two populations
 * #478 asked about. #478.
 *
 * An override is a value, never a null. A stored null was how a blank box used
 * to be saved, and the owner decided on 2026-09-29, on #478, that all of them
 * are mistakes: every one traced back to #317's whole-form saves, only the
 * Year column ever honoured one, and the edit form showed the work's value in
 * its place so the next save dropped it anyway. The form now refuses an
 * emptied field and the API refuses a null override, so nothing refills this.
 * ../null_override_plan.js has the argument in full.
 *
 * **This writes to `*Entries`, which ../../../CLAUDE.md reserves**, and the
 * case for the exception is that decision plus this: nothing on the page
 * changes. Every reader — the list columns, the Year column since #478, and
 * the export's `withOverrides` — already reads a null override as absent, so
 * `$unset`ting one makes the stored data say what the page already shows.
 * No user text is reachable from here: a null holds none.
 *
 * What bounds `--apply`:
 *
 * - It only `$unset`s `overrides.<field>` keys holding null, and the
 *   `overrides` object itself only when every key in it is null. A real
 *   value beside a null is never touched, on an entry with a work or without.
 * - Each update filters on the overrides object exactly as it was read, so an
 *   entry edited between the read and the write is left alone and reported
 *   as a shortfall rather than overwritten.
 * - It never touches `updatedDate`, which would reorder every list.
 * - It dumps each entry collection before writing to it. That is not the
 *   snapshot CLAUDE.md requires — take and verify that first.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed. Read-only unless
 * given `--apply`.
 *
 * Usage:
 *   node scripts/clear_null_overrides.js
 *   node scripts/clear_null_overrides.js --only=games --json=report.json
 *   node scripts/clear_null_overrides.js --apply
 *
 * Flags:
 *   --apply             unset every null override key (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --list              print every all-null entry, not only the mixed ones
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
const { planNullOverrideReport } = require("../null_override_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  list: args.list === true,
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
      ? "APPLY MODE: every null override key will be unset from entry documents."
      : "DRY RUN: nothing will be written."
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  let blocked = false;
  for (const collection of selected) {
    const result = await reportCollection(db, collection);
    report[collection.type] = result;
    if (result.blocked) blocked = true;
  }

  summarise(report);

  if (blocked) {
    console.error(
      "\nOne or more collections were refused, and nothing was written for " +
        "those. A works collection came back empty beside entries that point " +
        "at it, which is what a failed read looks like."
    );
    process.exitCode = 1;
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const reportCollection = async (db, collection) => {
  console.log(`\n=== ${collection.entries} ===`);

  const entries = await db.collection(collection.entries).find().toArray();
  const works = await db.collection(collection.works).find().toArray();

  const plan = planNullOverrideReport(entries, works);
  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  const { totals } = plan;
  console.log(
    `  ${totals.entries} entries, ${totals.withOverrides} carrying overrides ` +
      `(${totals.linkedWithOverrides} linked, ${totals.unlinkedWithOverrides} ` +
      `with no readable work)`
  );
  console.log(
    `  ${totals.nullKeys} null key(s) on ${totals.entriesTouched} entry(s) ` +
      `${options.apply ? "to unset" : "would be unset"} — ` +
      `${totals.objectsDropped} overrides object(s) left empty and dropped, ` +
      `${totals.unlinkedNullKeys} key(s) on entries with no work`
  );
  console.log(
    `  ${totals.allNull} linked entry(s) whose every override key is null, ` +
      `${totals.allNullHidingYear} of them over a work with a year`
  );
  console.log(
    `  ${totals.releaseYearNull} linked entry(s) with releaseYear: null over ` +
      `a work with a year — ${totals.releaseYearNull - totals.releaseYearNullMixed} ` +
      `all-null, ${totals.releaseYearNullMixed} mixed`
  );

  printCounts("by userId", plan.byUser);
  printCounts("by year of updatedDate", plan.byUpdatedYear);
  if (options.list) {
    printEntries(
      "ALL-NULL override objects on linked entries (dropped whole)",
      plan.allNull
    );
  }
  printEntries(
    "MIXED: releaseYear null beside a real override (the null goes, the rest stays)",
    plan.releaseYearNull.filter((reported) => !reported.allNull)
  );
  if (plan.unaddressable.length > 0) {
    console.error(
      `\n  ${plan.unaddressable.length} null key(s) KEPT — no update path can ` +
        `name them, and their object has other keys:`
    );
    for (const { _id, field } of plan.unaddressable) {
      console.error(`      ${_id} ${JSON.stringify(field)}`);
    }
  }

  const base = {
    totals,
    unaddressable: plan.unaddressable.map((u) => ({ ...u, _id: String(u._id) })),
    byUser: plan.byUser,
    byUpdatedYear: plan.byUpdatedYear,
    allNull: plan.allNull.map(toJson),
    releaseYearNull: plan.releaseYearNull.map(toJson),
  };

  if (!options.apply || plan.removals.length === 0) {
    return { ...base, unset: 0 };
  }

  backup(collection.entries, entries);
  const unset = await applyRemovals(db, collection, plan);
  const after = await countAfter(db, collection);
  console.log(
    `  after: ${after.entries} entries (was ${totals.entries}), ` +
      `${after.nullKeys} null override key(s) left`
  );
  if (after.entries !== totals.entries) {
    console.error(
      `  ENTRY COUNT CHANGED: ${totals.entries} -> ${after.entries}. ` +
        `Restore from the snapshot taken before this run.`
    );
    process.exitCode = 1;
  }
  return { ...base, unset, after };
};

/**
 * The filter carries the overrides object as read, so a document somebody
 * saved in the meantime no longer matches and is not written. Embedded
 * document equality is exact and key-ordered, and the object is handed back
 * exactly as the driver gave it.
 *
 * `$unset` and not `$set: {}` or a rebuilt object: each null key is removed
 * by name and nothing else in the object is written at all, so a real value
 * beside it cannot be altered by a mistake in how the object was rebuilt.
 */
const applyRemovals = async (db, collection, plan) => {
  const result = await db.collection(collection.entries).bulkWrite(
    plan.removals.map((removal) => ({
      updateOne: {
        filter: { _id: removal._id, overrides: removal.overrides },
        update: {
          $unset: removal.dropsObject
            ? { overrides: "" }
            : Object.fromEntries(
                removal.fields.map((field) => [`overrides.${field}`, ""])
              ),
        },
      },
    })),
    { ordered: false }
  );
  console.log(`  modified ${result.modifiedCount} entry(s)`);
  if (result.modifiedCount !== plan.removals.length) {
    console.error(
      `  expected ${plan.removals.length}, modified ${result.modifiedCount} — ` +
        `the rest changed after they were read, and were left alone.`
    );
    process.exitCode = 1;
  }
  return result.modifiedCount;
};

/** What is left, asked of the database rather than inferred from the plan. */
const countAfter = async (db, collection) => {
  const entries = db.collection(collection.entries);
  const withOverrides = await entries
    .find({ overrides: { $type: "object" } }, { projection: { overrides: 1 } })
    .toArray();
  return {
    entries: await entries.countDocuments(),
    nullKeys: withOverrides.reduce(
      (n, { overrides }) =>
        n + Object.values(overrides).filter((value) => value == null).length,
      0
    ),
  };
};

const printCounts = (label, counts) => {
  const rows = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return;
  console.log(`\n  ${label} (all-null / releaseYear null):`);
  for (const [key, count] of rows) {
    console.log(
      `      ${key.padEnd(26)} ${String(count.allNull).padStart(5)} ` +
        `${String(count.releaseYearNull).padStart(5)}`
    );
  }
};

/** Oldest save first, since the age is most of the argument either way. */
const printEntries = (label, reported) => {
  if (reported.length === 0) return;
  console.log(`\n  ${reported.length} ${label}:`);
  const sorted = [...reported].sort(
    (a, b) => toTime(a.updatedDate) - toTime(b.updatedDate)
  );
  for (const r of sorted) {
    const keys = r.fields
      .map((field) => (r.nullFields.includes(field) ? field : `${field}=<set>`))
      .join(", ");
    console.log(
      `      ${r._id} user=${r.userId} updated=${toDay(r.updatedDate)} ` +
        `year=${r.workYear ?? "-"} [${keys}]`
    );
  }
};

const toJson = (r) => ({
  ...r,
  _id: String(r._id),
  userId: r.userId === undefined ? null : String(r.userId),
  workRef: String(r.workRef),
  updatedDate: toDay(r.updatedDate),
});

const summarise = (report) => {
  const sum = (key) =>
    Object.values(report).reduce((n, r) => n + (r.totals?.[key] ?? 0), 0);
  console.log(
    `\n${sum("nullKeys")} null override key(s) on ${sum("entriesTouched")} ` +
      `entry(s) ${options.apply ? "to unset" : "would be unset"}, ` +
      `${sum("objectsDropped")} object(s) dropped whole, ` +
      `${sum("unlinkedNullKeys")} key(s) on entries with no work.`
  );
  console.log(
    `${sum("allNull")} all-null override object(s) on linked entries ` +
      `(${sum("allNullHidingYear")} hiding a year); ${sum("releaseYearNull")} ` +
      `linked entry(s) with releaseYear: null over a work with a year, ` +
      `${sum("releaseYearNullMixed")} of them mixed.`
  );
  console.log(
    options.apply
      ? `${Object.values(report).reduce((n, r) => n + (r.unset ?? 0), 0)} ` +
          `entry(s) modified; ` +
          `${Object.values(report).reduce((n, r) => n + (r.after?.nullKeys ?? 0), 0)} ` +
          `null key(s) left.`
      : "Nothing written."
  );
};

const toTime = (value) => {
  const time = new Date(value ?? NaN).getTime();
  return Number.isNaN(time) ? -Infinity : time;
};

const toDay = (value) => {
  const time = toTime(value);
  return time === -Infinity ? "unknown" : new Date(time).toISOString().slice(0, 10);
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
