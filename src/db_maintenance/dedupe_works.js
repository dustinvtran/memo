#!/usr/bin/env node
/**
 * @file Collapses duplicate cached works and repoints the entries that refer
 * to them (issue #83).
 *
 * This is the destructive half of the cleanup: it deletes documents. It is a
 * dry run unless you pass --apply, it backs up both the work and the entry
 * collection first, and it only ever groups works that share an API
 * identifier AND agree about the title. Which document survives and what gets
 * merged into it is decided by ./work_dedupe_plan.js, which is unit tested.
 *
 * The title check matters: sharing an apiRef does not mean being the same
 * work. "Fargo - Season 1" and "Fargo - Season 2" sit under one show id, five
 * Haruhi Suzumiya volumes share one ISBN, and "Demons" is filed under The Da
 * Vinci Code's. Those groups are reported and skipped;
 * --merge-title-mismatches forces them through, and you should read every one
 * of them first.
 *
 * Order of operations per group: update the survivor, repoint the entries,
 * then delete the duplicates. If the run dies half way, re-running converges
 * on the same survivor.
 *
 * Environment (.env in this folder): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node dedupe_works.js
 *   node dedupe_works.js --only=books
 *   node dedupe_works.js --only=books --apply
 *
 * Flags:
 *   --apply             actually write (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --keep-duplicates   merge and repoint, but don't delete the leftovers
 *   --merge-title-mismatches
 *                       also merge groups whose titles disagree (dangerous)
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put backups (default ./backups)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  selectCollections,
  parseArgs,
} = require("./work_collections");
const { planDedupe } = require("./work_dedupe_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  keepDuplicates: args["keep-duplicates"] === true,
  mergeTitleMismatches: args["merge-title-mismatches"] === true,
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "backups")),
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
      ? "APPLY MODE: works will be merged and duplicates deleted."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  for (const collection of selected) {
    report[collection.type] = await dedupeCollection(db, collection);
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${args.json}`);
  }

  await client.close();
};

const dedupeCollection = async (db, collection) => {
  console.log(`\n=== ${collection.works} ===`);

  const works = await db.collection(collection.works).find().toArray();
  const entries = await db.collection(collection.entries).find().toArray();

  const allGroups = planDedupe(collection, works, entries, {
    includeTitleMismatches: true,
  });
  const plans = options.mergeTitleMismatches
    ? allGroups
    : allGroups.filter((p) => p.titlesAgree);
  const skipped = allGroups.filter((p) => !plans.includes(p));

  const duplicateCount = plans.reduce((n, p) => n + p.duplicateIds.length, 0);
  const repointCount = plans.reduce((n, p) => n + p.entriesToRepoint.length, 0);

  console.log(
    `  ${works.length} works, ${plans.length} duplicate groups, ` +
      `${duplicateCount} documents to remove, ${repointCount} entries to repoint`
  );

  if (skipped.length > 0) {
    console.log(
      `  ${skipped.length} group(s) skipped: the works share an apiRef but not ` +
        `a title, so they are probably distinct works filed under one id`
    );
    for (const group of skipped) {
      console.log(`      ${group.key}: ${JSON.stringify(group.titles)}`);
    }
  }

  if (plans.length === 0) return { works: works.length, groups: 0, skipped };

  for (const plan of plans) {
    console.log(
      `  * ${plan.key}: keeping ${plan.survivorId} (${plan.titles[0]}), ` +
        `merging ${plan.duplicateIds.length} duplicate(s)` +
        `${
          Object.keys(plan.updates).length > 0
            ? `, filling ${Object.keys(plan.updates).join(", ")}`
            : ""
        }` +
        `${
          plan.entriesToRepoint.length > 0
            ? `, repointing ${plan.entriesToRepoint.length} entry(s)`
            : ""
        }`
    );
    const otherTitles = [...new Set(plan.titles.slice(1))].filter(
      (t) => t !== plan.titles[0]
    );
    if (otherTitles.length > 0) {
      console.log(
        `      note: duplicates have different titles: ${otherTitles.join(", ")}`
      );
    }
  }

  if (!options.apply) {
    return { works: works.length, groups: plans.length, plans, skipped };
  }

  backup(collection.works, works);
  backup(collection.entries, entries);

  for (const plan of plans) {
    if (Object.keys(plan.updates).length > 0) {
      await db
        .collection(collection.works)
        .updateOne({ _id: plan.survivorId }, { $set: plan.updates });
    }

    if (plan.entriesToRepoint.length > 0) {
      await db
        .collection(collection.entries)
        .updateMany(
          { _id: { $in: plan.entriesToRepoint } },
          { $set: { workRef: plan.survivorId } }
        );
    }

    if (!options.keepDuplicates) {
      await db
        .collection(collection.works)
        .deleteMany({ _id: { $in: plan.duplicateIds } });
    }
  }

  console.log(
    `  merged ${plans.length} groups, repointed ${repointCount} entries, ` +
      `${options.keepDuplicates ? "kept" : "deleted"} ${duplicateCount} duplicates`
  );

  return { works: works.length, groups: plans.length, plans, skipped };
};

const backup = (collectionName, documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${collectionName}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`  backed up ${documents.length} documents to ${file}`);
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
