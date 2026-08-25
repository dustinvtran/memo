#!/usr/bin/env node
/**
 * @file Repairs `duration` values that cannot be true.
 *
 * The case this was written for: the games collection stored Dying Light at
 * `2939328000000000` minutes — 5.6 billion hours — which is exactly 1050 × 60^7.
 * A units conversion was applied to a value already in the right units, seven
 * times over. Four of the six entries pointing at that work carry an
 * `overrides.duration` of 1050, so the people reading the column had already
 * worked out what the number should have been and fixed it for themselves.
 *
 * Which values are impossible, and which of the possible ones a broken number
 * is allowed to be repaired to, is ../duration_plausibility.js's job — pure,
 * unit tested, and the only place the rules are written down. This file is the
 * I/O around it.
 *
 * **Writes only to the work collections.** `*Entries` is read, for the
 * overrides that corroborate a repair, and never written: an override is what
 * a user typed, and CLAUDE.md's rule about that is what keeps this a repair.
 *
 * A dry run unless given `--apply`, and it dumps every collection it is about
 * to write to first, like its neighbours. That dump is a convenience, not the
 * safety net: take a fresh snapshot with scripts/backup_database.js before
 * every `--apply`, including the runs you are sure will touch nothing.
 *
 * Usage:
 *   node scripts/repair_durations.js
 *   node scripts/repair_durations.js --only=games
 *   node scripts/repair_durations.js --apply
 *   node scripts/repair_durations.js --json=./durations.json
 *
 * Flags:
 *   --only=a,b          only these types (default: all four)
 *   --apply             write (default: dry run)
 *   --backup-dir=path   where the pre-write dump goes (default ../backups)
 *   --json=path         write the full plan to a file
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
  bandFor,
  planDurationRepairs,
  durationOverridesByWorkRef,
} = require("../duration_plausibility");

const args = parseArgs(process.argv);
const apply = args.apply === true;
const backupDir = String(
  args["backup-dir"] ?? path.join(__dirname, "..", "backups")
);

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

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  console.log(
    apply
      ? "APPLYING — writing to the work collections."
      : "DRY RUN — nothing will be written. Pass --apply to write."
  );

  const report = {};
  let repaired = 0;
  let blocked = 0;

  for (const collection of selected) {
    const plan = await planFor(db, collection);
    report[collection.type] = plan;
    printPlan(collection, plan);

    blocked += plan.needsHuman.length;
    if (apply && plan.repair.length > 0) {
      await backup(db, collection);
      repaired += await applyPlan(db, collection, plan);
      await verify(db, collection, plan);
    }
  }

  console.log(
    `\n${apply ? "Repaired" : "Would repair"} ${
      apply ? repaired : totalRepairs(report)
    } duration(s); ${blocked} need a human.`
  );

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const planFor = async (db, collection) => {
  const works = await db
    .collection(collection.works)
    .find({}, { projection: { englishTranslatedTitle: 1, originalTitle: 1, duration: 1, durationSource: 1 } })
    .toArray();
  const entries = await db
    .collection(collection.entries)
    .find({}, { projection: { workRef: 1, overrides: 1 } })
    .toArray();

  return planDurationRepairs(
    collection,
    works,
    durationOverridesByWorkRef(entries)
  );
};

/**
 * `duration` and nothing else. `durationSource` is deliberately left exactly
 * as it is: it records where the number came from, the repaired number is the
 * same measurement the source gave us with the multiplications undone, and
 * writing one here would claim a provenance this script has not established.
 * See `mergeWork` in ../work_metadata_merge.js for the same rule the other way
 * round.
 */
const applyPlan = async (db, collection, plan) => {
  let repaired = 0;
  for (const finding of plan.repair) {
    const result = await db
      .collection(collection.works)
      .updateOne(
        { _id: finding.id, duration: finding.current },
        { $set: { duration: finding.duration } }
      );
    if (result.matchedCount === 0) {
      console.log(`  ! ${finding.title} changed under us — skipped`);
      continue;
    }
    repaired += result.modifiedCount;
  }
  return repaired;
};

/**
 * Reads back what was written and checks that nothing else moved.
 *
 * The counts matter as much as the values: a repair is one `$set` on one
 * field, so a work or entry count that has changed means something other than
 * what was planned has happened, whatever the durations now say.
 */
const verify = async (db, collection, plan) => {
  const works = db.collection(collection.works);
  const readBack = await works
    .find(
      { _id: { $in: plan.repair.map((finding) => finding.id) } },
      { projection: { duration: 1 } }
    )
    .toArray();
  const byId = new Map(readBack.map((work) => [String(work._id), work.duration]));
  const wrong = plan.repair.filter(
    (finding) => byId.get(String(finding.id)) !== finding.duration
  );

  const remaining = planDurationRepairs(
    collection,
    await works.find({}, { projection: { englishTranslatedTitle: 1, originalTitle: 1, duration: 1 } }).toArray(),
    new Map()
  );

  console.log(`\n--- verification: ${collection.works} ---`);
  console.log(`  repaired and readable back: ${plan.repair.length - wrong.length}/${plan.repair.length}`);
  console.log(`  works:   ${plan.checked} -> ${remaining.checked}`);
  console.log(
    `  still implausible: ${remaining.repair.length + remaining.needsHuman.length}` +
      ` (was ${plan.repair.length + plan.needsHuman.length})`
  );

  if (wrong.length > 0 || remaining.checked !== plan.checked) {
    console.error("\nVERIFICATION FAILED. Restore from the snapshot you took.");
    process.exitCode = 1;
  }
};

const backup = (db, collection) =>
  db
    .collection(collection.works)
    .find()
    .toArray()
    .then((documents) => {
      fs.mkdirSync(backupDir, { recursive: true });
      const file = path.join(
        backupDir,
        `${collection.works}_${new Date().toISOString().replace(/:/g, "-")}.json`
      );
      fs.writeFileSync(file, JSON.stringify(documents, null, 2));
      console.log(`\n  backed up ${documents.length} documents to ${file}`);
    });

const printPlan = (collection, plan) => {
  const band = bandFor(collection);
  console.log(
    `\n=== ${collection.works} === ${plan.checked} works, ceiling ${band.max} ${band.unit}`
  );

  if (plan.repair.length === 0 && plan.needsHuman.length === 0) {
    console.log("  every duration is plausible");
    return;
  }

  for (const finding of plan.repair) {
    console.log(`  FIX  ${finding.title}`);
    console.log(`         ${finding.reason}`);
    console.log(`         ${finding.current} -> ${finding.duration}`);
    console.log(`         ${finding.evidence}`);
  }

  for (const finding of plan.needsHuman) {
    console.log(`  ??   ${finding.title}`);
    console.log(`         ${finding.reason}`);
    console.log(
      `         ${finding.blocked}` +
        (finding.ladder.length ? ` (ladder: ${finding.ladder.join(", ")})` : "") +
        (finding.overrides.length
          ? ` (overrides: ${finding.overrides.join(", ")})`
          : " (no entry overrides)")
    );
  }
};

const totalRepairs = (report) =>
  Object.values(report).reduce((n, plan) => n + plan.repair.length, 0);

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
