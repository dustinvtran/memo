#!/usr/bin/env node
/**
 * @file Reports the linked entries whose overrides object is nothing but
 * `null`s, and the ones storing `overrides.releaseYear: null` over a work that
 * has a year; with `--apply`, unsets the first kind and nothing else. #478.
 *
 * The Year column is the one column that keeps a null override rather than
 * falling through to the work — `getOverrideOrMetadataPreserveNull` in
 * ../../frontend/_includes/js/utils/columns.js — so a stored null draws a dash
 * where the work's year would be. An entry whose every override key is null
 * is the shape #317's bug left, the whole blank form stored as overrides in
 * one save, rather than one field cleared by hand. ../null_override_plan.js
 * has the argument in full.
 *
 * **Run the dry run; do not run `--apply` without the owner's say-so.** This
 * writes to `*Entries`, which ../../../CLAUDE.md reserves, and unlike
 * ./clear_noop_overrides.js and ./clear_blank_overrides.js its case is not
 * made: a null is a legitimate way to hide a year, and nothing in the data
 * tells a deliberate one from the bug's. The dry run exists to put the list in
 * front of the person who can say which these are. The `--apply` half is here
 * so that the answer, if it is "the bug's", is one command rather than a new
 * script written in a hurry.
 *
 * What bounds `--apply`, if it is ever given:
 *
 * - It only `$unset`s the `overrides` object, and only on a linked entry whose
 *   every key is null. A mixed entry — a null year beside a real override —
 *   is listed and never written to. So is every entry with no work.
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
 *
 * Flags:
 *   --apply             unset the all-null override objects (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
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
      ? "APPLY MODE: all-null override objects will be unset from entry documents."
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
      `with no readable work and left out)`
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
  printEntries(
    "ALL-NULL override objects (what --apply would unset)",
    plan.allNull
  );
  printEntries(
    "MIXED: releaseYear null beside another override (never written to)",
    plan.releaseYearNull.filter((reported) => !reported.allNull)
  );

  const base = {
    totals,
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
  const after = await db.collection(collection.entries).countDocuments();
  console.log(`  after: ${after} entries (was ${totals.entries})`);
  if (after !== totals.entries) {
    console.error(
      `  ENTRY COUNT CHANGED: ${totals.entries} -> ${after}. ` +
        `Restore from the snapshot taken before this run.`
    );
    process.exitCode = 1;
  }
  return { ...base, unset };
};

/**
 * The filter carries the overrides object as read, so a document somebody
 * saved in the meantime no longer matches and is not written. Embedded
 * document equality is exact and key-ordered, and the object is handed back
 * exactly as the driver gave it.
 */
const applyRemovals = async (db, collection, plan) => {
  const result = await db.collection(collection.entries).bulkWrite(
    plan.removals.map((removal) => ({
      updateOne: {
        filter: { _id: removal._id, overrides: removal.overrides },
        update: { $unset: { overrides: "" } },
      },
    })),
    { ordered: false }
  );
  console.log(`  unset ${result.modifiedCount} overrides object(s)`);
  if (result.modifiedCount !== plan.removals.length) {
    console.error(
      `  expected ${plan.removals.length}, modified ${result.modifiedCount} — ` +
        `the rest changed after they were read, and were left alone.`
    );
    process.exitCode = 1;
  }
  return result.modifiedCount;
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
    `\n${sum("allNull")} all-null override object(s) on linked entries ` +
      `(${sum("allNullHidingYear")} hiding a year); ${sum("releaseYearNull")} ` +
      `linked entry(s) with releaseYear: null over a work with a year, ` +
      `${sum("releaseYearNullMixed")} of them mixed.`
  );
  console.log(
    options.apply
      ? `${Object.values(report).reduce((n, r) => n + (r.unset ?? 0), 0)} ` +
          `overrides object(s) unset.`
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
