#!/usr/bin/env node
/**
 * @file Removes the two fields on an entry document that nothing reads.
 *
 * `review` is a second copy of the note whose home is the `*Reviews`
 * collections, and `commonMetadata` is a pre-migration snapshot of the work
 * the entry points at, which the read path overwrites from the `$lookup` on
 * every request. Together they are 3.21 MB of the entry collections' 4.32 MB
 * — the stale copies disagree with the `works` collections they mirror, and
 * the notes are read out of Atlas on every list load to be projected away.
 * See #176 for the measurements and ../dead_entry_fields_plan.js for why each
 * one is safe to drop.
 *
 * This is the second script here that writes outside the work collections,
 * and unlike ../scripts/prune_orphan_reviews.js it writes to `*Entries`
 * directly. That is the rule in ../../../CLAUDE.md bent as far as it goes, so
 * it is bent narrowly:
 *
 * - It only ever `$unset`s those two named fields. `overrides`, `status`,
 *   `score`, the dates and `workRef` are unreachable from here, and the
 *   `$unset` cannot create, delete or repoint a document.
 * - It never touches `updatedDate`. A write that bumped it would reorder
 *   every list in the site, which is a visible change to data nobody asked to
 *   change.
 * - **It verifies before it drops a note.** Every entry carrying a `review`
 *   must have a review document holding the same text, verbatim; an entry
 *   that fails is reported and left entirely alone, both fields. 1034 notes
 *   is not something to drop on the assumption the other copy is there.
 *
 * The write side that refills these is #171 / PR #183, which validates a
 * PATCH body instead of storing it wholesale. Until that lands, saving an
 * entry through the form writes both fields back onto it, so a run of this
 * clears the backlog rather than settling the question.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/strip_dead_entry_fields.js
 *   node scripts/strip_dead_entry_fields.js --only=games
 *   node scripts/strip_dead_entry_fields.js --fields=commonMetadata
 *   node scripts/strip_dead_entry_fields.js --apply
 *
 * Flags:
 *   --apply             actually unset (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --fields=a,b        restrict to these fields (review, commonMetadata)
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
  DEAD_FIELDS,
  planDeadFieldRemoval,
} = require("../dead_entry_fields_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  fields: args.fields === undefined ? DEAD_FIELDS : String(args.fields).split(","),
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
      ? "APPLY MODE: dead fields will be unset from entry documents."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );
  console.log(`Fields: ${options.fields.join(", ")}`);

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  let blocked = false;
  for (const collection of selected) {
    const result = await stripCollection(db, collection);
    report[collection.type] = result;
    if (result.blocked) blocked = true;
  }

  summarise(report);

  if (blocked) {
    console.error(
      "\nOne or more collections were refused. Nothing was written for those. " +
        "This means the reviews collection came back empty beside entries that " +
        "carry notes, which is what a failed read looks like — check the " +
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

const stripCollection = async (db, collection) => {
  console.log(`\n=== ${collection.entries} ===`);

  const entries = await db.collection(collection.entries).find().toArray();
  const reviews = await db.collection(collection.reviews).find().toArray();

  const plan = planDeadFieldRemoval(entries, reviews, options.fields);

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  console.log(
    `  ${plan.totals.entries} entries, ` +
      `${plan.totals.carryingReview} carrying a note, ` +
      `${plan.totals.carryingCommonMetadata} carrying stale metadata`
  );
  console.log(
    `  verified and unsettable: ` +
      `review on ${plan.review.ids.length} (${toKb(plan.review.jsonChars)}), ` +
      `commonMetadata on ${plan.commonMetadata.ids.length} ` +
      `(${plan.commonMetadata.nulls} null, ${plan.commonMetadata.objects} stale ` +
      `objects, ${toKb(plan.commonMetadata.jsonChars)})`
  );

  if (plan.mismatches.length > 0) {
    // The lengths, never the text: this is somebody's writing, and a terminal
    // log is not where it should turn up. Anything listed here is left alone.
    console.error(
      `\n  ${plan.mismatches.length} entry(s) REFUSED — the note on the entry ` +
        `is not verbatim in ${collection.reviews}. Nothing at all was unset ` +
        `from these:`
    );
    for (const mismatch of plan.mismatches) {
      console.error(
        `      ${mismatch._id}: ${mismatch.reason} ` +
          `(entry ${mismatch.entryChars} chars, ` +
          `stored ${mismatch.storedChars ?? "-"} chars)`
      );
    }
    console.error(
      `  Read these through the app before deciding. Re-running does not ` +
        `change the answer: the check is equality, so a note only becomes ` +
        `droppable once the two copies genuinely agree.\n`
    );
  }

  const base = {
    entries: plan.totals.entries,
    review: plan.review.ids.length,
    commonMetadata: plan.commonMetadata.ids.length,
    reviewChars: plan.review.jsonChars,
    commonMetadataChars: plan.commonMetadata.jsonChars,
    mismatches: plan.mismatches,
    skipped: plan.totals.skipped,
  };

  const nothingToDo =
    plan.review.ids.length === 0 && plan.commonMetadata.ids.length === 0;
  if (!options.apply || nothingToDo) {
    return { ...base, unset: { review: 0, commonMetadata: 0 } };
  }

  backup(collection.entries, entries);

  // Two `updateMany`s rather than a bulk write of per-document `$unset`s: the
  // fields are unset from different sets of entries, but within each set the
  // operation is identical, so this is the whole job in two round trips.
  //
  // `$unset` and not `$set: { field: null }` — a null is still a field being
  // stored and read out, which is what 762 of these already were. And no
  // `updatedDate`: bumping it would reorder every list on the site.
  const unset = {
    review: await unsetField(db, collection, "review", plan.review.ids),
    commonMetadata: await unsetField(
      db,
      collection,
      "commonMetadata",
      plan.commonMetadata.ids
    ),
  };

  const remaining = await countRemaining(db, collection, plan);
  console.log(
    `  after: ${remaining.entries} entries (was ${plan.totals.entries}), ` +
      `${remaining.review} still carrying a note, ` +
      `${remaining.commonMetadata} still carrying stale metadata`
  );

  if (remaining.entries !== plan.totals.entries) {
    console.error(
      `  ENTRY COUNT CHANGED: ${plan.totals.entries} -> ${remaining.entries}. ` +
        `Restore from the snapshot taken before this run.`
    );
    process.exitCode = 1;
  }

  return { ...base, unset, remaining };
};

/** @type {(db: any, collection: any, field: string, ids: any[]) => Promise<number>} */
const unsetField = async (db, collection, field, ids) => {
  if (ids.length === 0) return 0;

  const result = await db
    .collection(collection.entries)
    .updateMany({ _id: { $in: ids } }, { $unset: { [field]: "" } });

  console.log(`  unset ${field} from ${result.modifiedCount} entry(s)`);
  if (result.modifiedCount !== ids.length) {
    console.error(
      `  expected ${ids.length}, modified ${result.modifiedCount} — ` +
        `something else is writing to ${collection.entries}.`
    );
    process.exitCode = 1;
  }
  return result.modifiedCount;
};

/**
 * What is left, asked of the database rather than inferred from the plan. The
 * entries a mismatch spared still carry theirs, so this is expected to be
 * non-zero exactly when something was refused.
 */
const countRemaining = async (db, collection, plan) => {
  const entriesCollection = db.collection(collection.entries);
  return {
    entries: await entriesCollection.countDocuments(),
    review: await entriesCollection.countDocuments({ review: { $exists: true } }),
    commonMetadata: await entriesCollection.countDocuments({
      commonMetadata: { $exists: true },
    }),
    expectedRefused: plan.totals.skipped,
  };
};

const summarise = (report) => {
  const totals = Object.values(report).reduce(
    (sum, r) => ({
      review: sum.review + (r.review ?? 0),
      commonMetadata: sum.commonMetadata + (r.commonMetadata ?? 0),
      chars: sum.chars + (r.reviewChars ?? 0) + (r.commonMetadataChars ?? 0),
      skipped: sum.skipped + (r.skipped ?? 0),
    }),
    { review: 0, commonMetadata: 0, chars: 0, skipped: 0 }
  );

  console.log(
    `\n${totals.review} note(s) and ${totals.commonMetadata} stale metadata ` +
      `object(s) ${options.apply ? "removed" : "would be removed"}, ` +
      `${toKb(totals.chars)} in all.`
  );
  if (totals.skipped > 0) {
    console.log(
      `${totals.skipped} entry(s) were left untouched because their note ` +
        `could not be verified. See the per-collection output above.`
    );
  }
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
