#!/usr/bin/env node
/**
 * @file Rewrites `entryRevisions.entryType` from the url spelling to the one
 * every other collection uses: `films` -> `Film`, `tv` -> `TVShow`.
 *
 * `entryType` meant two different things — `Film` on a work document, `films`
 * on a revision — because `toEntryType` returned the `:type` url segment under
 * a name that promised the other value, and both of its callers stored it in a
 * field they also called `entryType`. The API writes the document spelling as
 * of #220; this is the backfill for everything written before it. See
 * ../entry_revision_type_plan.js for the mapping and what it refuses.
 *
 * This is the third script here that writes outside the work collections, and
 * ../../../CLAUDE.md asks for that to be a deliberate exception rather than a
 * habit. It is narrow in the way the rule cares about:
 *
 * - It `$set`s one field, `entryType`, to one of four constants that come out
 *   of the shared table. `snapshot` — which is where the writing people can
 *   still read back lives — is unreachable from here, and so are `entryRef`,
 *   `kind` and `userId`.
 * - **It never reads a snapshot.** The plan needs `_id`, `entryType` and
 *   `kind`, so that is the projection: no note is loaded, printed, or written
 *   to the before-map.
 * - It touches no dates. A revision's `createdDate` and `supersededDate` say
 *   when a version was saved and when it was replaced, and a migration is
 *   neither of those things.
 * - A document carrying neither spelling is reported and skipped rather than
 *   guessed at.
 *
 * Take a snapshot with backup_database.js first — every `--apply` in this
 * folder wants one, and the before-map this writes is a convenience rather
 * than a substitute: it can put the four values back, and nothing else.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/retype_entry_revisions.js
 *   node scripts/retype_entry_revisions.js --apply
 *
 * Flags:
 *   --apply             actually rewrite (default: dry run)
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put the before-map (default ../backups)
 */
require("../env");
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { parseArgs } = require("../work_collections");
const {
  RETYPE,
  planEntryRevisionRetype,
} = require("../entry_revision_type_plan");

const COLLECTION = "entryRevisions";

/** Everything the plan reads, and deliberately nothing else. */
const PLAN_FIELDS = { _id: 1, entryType: 1, kind: 1 };

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

let client;

const main = async () => {
  console.log(
    options.apply
      ? `APPLY MODE: entryType will be rewritten on ${COLLECTION} documents.`
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const documents = await db
    .collection(COLLECTION)
    .find({}, { projection: PLAN_FIELDS })
    .toArray();

  const plan = planEntryRevisionRetype(documents);

  if (plan.blocked) {
    console.error(`REFUSED: ${plan.blocked}`);
    process.exitCode = 1;
    await client.close();
    return;
  }

  report(plan);

  const result =
    plan.totals.toRewrite > 0 && options.apply
      ? await rewrite(db, plan)
      : undefined;

  if (args.json) {
    fs.writeFileSync(
      String(args.json),
      JSON.stringify({ ...plan, result }, null, 2)
    );
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const report = (plan) => {
  console.log(
    `\n${plan.totals.revisions} document(s) in ${COLLECTION}: ` +
      `${plan.totals.alreadyCorrect} already correct, ` +
      `${plan.totals.toRewrite} to rewrite, ` +
      `${plan.totals.unrecognised} unrecognised`
  );

  for (const update of plan.updates) {
    console.log(
      `  ${update.from} -> ${update.to}: ${update.ids.length} document(s)` +
        (update.drafts > 0 ? ` (${update.drafts} of them drafts)` : "")
    );
  }

  if (plan.unrecognised.length > 0) {
    console.error(
      `\n  ${plan.unrecognised.length} document(s) carry an entryType that is ` +
        `neither spelling. Nothing was written to these — their type is ` +
        `recoverable from the entry they belong to, which beats a guess:`
    );
    for (const document of plan.unrecognised) {
      console.error(
        `      ${document._id}: ${JSON.stringify(document.entryType)} ` +
          `(${document.kind ?? "no kind"})`
      );
    }
  }
};

const rewrite = async (db, plan) => {
  writeBeforeMap(plan);

  const collection = db.collection(COLLECTION);
  const before = await collection.countDocuments();

  // One `updateMany` per value written rather than a write per document: the
  // documents of a type are all getting the same constant, so this is the
  // whole job in four round trips at most.
  const modified = {};
  for (const update of plan.updates) {
    const result = await collection.updateMany(
      { _id: { $in: update.ids } },
      { $set: { entryType: update.to } }
    );
    modified[update.to] = result.modifiedCount;
    console.log(`  rewrote ${result.modifiedCount} document(s) to ${update.to}`);
    if (result.modifiedCount !== update.ids.length) {
      console.error(
        `  expected ${update.ids.length}, modified ${result.modifiedCount} — ` +
          `something else is writing to ${COLLECTION}.`
      );
      process.exitCode = 1;
    }
  }

  const after = await collection.countDocuments();
  const remaining = await collection.countDocuments({
    entryType: { $in: Object.keys(RETYPE) },
  });

  console.log(
    `\nafter: ${after} document(s) (was ${before}), ` +
      `${remaining} still carrying a url spelling`
  );

  // The two things a rewrite of one field must not have done: changed how many
  // documents there are, or left the collection half-migrated.
  if (after !== before) {
    console.error(
      `DOCUMENT COUNT CHANGED: ${before} -> ${after}. Restore from the ` +
        `snapshot taken before this run.`
    );
    process.exitCode = 1;
  }
  if (remaining !== 0) {
    console.error(
      `${remaining} document(s) still carry a url spelling. Re-run to see ` +
        `what they are.`
    );
    process.exitCode = 1;
  }

  return { modified, before, after, remaining };
};

/**
 * The `_id`s and the values they are about to stop having — an exact inverse
 * of this run, small enough to read. Not a backup of the collection: the
 * documents were never fully loaded, on purpose.
 */
const writeBeforeMap = (plan) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${COLLECTION}_entryType_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  const before = plan.updates.flatMap((update) =>
    update.ids.map((_id) => ({ _id, entryType: update.from }))
  );
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  console.log(
    `\n  wrote a before-map of ${before.length} document(s) to ${file}`
  );
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
