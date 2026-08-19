#!/usr/bin/env node
/**
 * @file Deletes reviews whose entry no longer exists.
 *
 * A review is only ever found by `entryRef`, so one whose entry is gone is
 * unreachable by every code path the site has. They accumulated because until
 * #117 (2026-08-12) deleting an entry left its review behind; the population
 * is that bug's backlog rather than an ongoing leak.
 *
 * This is the only script here that writes to a collection other than the
 * work collections, and it does so deliberately: the note it removes belonged
 * to an entry the user deleted. Every one of the 248 found in August 2026 was
 * read before this was run — the ones holding text were attributed to the work
 * they belonged to, and the surviving note was confirmed to be the fuller
 * version. See ../README.md.
 *
 * It never touches `*Entries`, so no user override or live note is reachable
 * from here, and a review it removes is restorable by `_id` from the snapshot
 * taken immediately before the run.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/prune_orphan_reviews.js
 *   node scripts/prune_orphan_reviews.js --only=games
 *   node scripts/prune_orphan_reviews.js --apply
 *
 * Flags:
 *   --apply             actually delete (default: dry run)
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
const { planOrphanReviewRemoval } = require("../orphan_review_plan");

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
      ? "APPLY MODE: unreachable reviews will be deleted."
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
    const result = await pruneCollection(db, collection);
    report[collection.type] = result;
    if (result.blocked) blocked = true;
  }

  const totals = Object.values(report).reduce(
    (sum, r) => ({
      orphans: sum.orphans + (r.orphans ?? 0),
      withText: sum.withText + (r.withText ?? 0),
    }),
    { orphans: 0, withText: 0 }
  );
  console.log(
    `\n${totals.orphans} unreachable review(s) in total, ` +
      `${totals.withText} of them holding text.`
  );

  if (blocked) {
    console.error(
      "\nOne or more collections were refused. Nothing was deleted for those. " +
        "This means an entry collection came back empty, which is what a failed " +
        "read looks like — check the connection before re-running."
    );
    process.exitCode = 1;
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const pruneCollection = async (db, collection) => {
  console.log(`\n=== ${collection.reviews} ===`);

  const entries = await db.collection(collection.entries).find().toArray();
  const reviews = await db.collection(collection.reviews).find().toArray();

  const plan = planOrphanReviewRemoval(entries, reviews);

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  console.log(
    `  ${reviews.length} review(s), ${entries.length} entries, ` +
      `${plan.orphans.length} unreachable ` +
      `(${plan.withText.length} holding text, ${plan.empty.length} empty)`
  );

  if (plan.orphans.length === 0) {
    return { reviews: reviews.length, orphans: 0, withText: 0, deleted: 0 };
  }

  // The text is a user's writing; its length is enough to size what is going
  // without printing it into a terminal log.
  for (const review of plan.withText) {
    console.log(
      `      ${review._id} (entryRef ${review.entryRef}, ${review.text.length} chars)`
    );
  }

  const base = {
    reviews: reviews.length,
    orphans: plan.orphans.length,
    withText: plan.withText.length,
    ids: plan.orphans.map((r) => String(r._id)),
  };

  if (!options.apply) return { ...base, deleted: 0 };

  backup(collection.reviews, reviews);

  const result = await db
    .collection(collection.reviews)
    .deleteMany({ _id: { $in: plan.orphans.map((r) => r._id) } });

  console.log(`  deleted ${result.deletedCount} review(s)`);
  return { ...base, deleted: result.deletedCount };
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
