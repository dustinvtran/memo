#!/usr/bin/env node
/**
 * @file Removes the field values on a work document that are present and
 * unusable — `publishers: {}`, `externalUrls: [[]]`, `directors: [""]`.
 *
 * The audit reports 637 of these across the four work collections and cannot
 * do anything about them, and nor could anything else here until this
 * existed. `mergeWork` only ever writes a field the adapter returned a
 * non-empty value for, and never clears one; that rule is what stops a bad API
 * day emptying the database, but it also means a corrupt value can be replaced
 * and never removed. The 78 books Google Books has no publisher for keep their
 * `{}` however many times the backfill runs. See #291 for the census and #292
 * for the render crash `publishers: {}` causes.
 *
 * **`$unset`, not `$set`.** A missing field is what `isEmptyValue` recognises,
 * so a cleared field reads as a gap: `hasGaps` picks the work up on the next
 * ordinary backfill and fills it if the API has anything to say. Set to `[]`
 * or `null` instead and the value would still be there, still be read out of
 * Atlas, and still be a thing the merge has to have an opinion about.
 *
 * What decides is ../unusable_field_plan.js, which asks the audit's own
 * predicates — `isCorruptStringArray`, `isCorruptNumber`,
 * `isCorruptExternalUrls` — rather than restating them. Two fields the audit
 * also calls corrupt are deliberately out of reach: `apiRefs`, because the
 * ones it reports are *absent* and there is nothing to unset, and `entryType`,
 * because a wrong one needs the right constant written over it.
 *
 * It writes only to the **work** collections, so no `*Entries` document and no
 * `entry.overrides` is reachable from it — the same guarantee the two
 * backfills have, and the reason this needed no exception to the rule in
 * ../../../CLAUDE.md. What else bounds it:
 *
 * - It only ever `$unset`s. It cannot create, delete or repoint a document,
 *   and it cannot write a value of any kind.
 * - **A value that still holds something usable is printed and left alone.**
 *   `["", "Christopher Nolan"]` is corrupt by the same predicate as `[""]`,
 *   and an unset would take the director with it. Salvaging is a `$set` and a
 *   different decision.
 *   Every one of the 637 in production is unusable end to end, so this is
 *   expected to report nothing — which is the point of printing it.
 * - It re-reads each collection afterwards and re-plans against it, so a run
 *   that did something other than what it planned says so.
 *
 * Take a snapshot with backup_database.js first and verify it — every
 * `--apply` in this folder wants one, and the per-collection dump this writes
 * is a convenience rather than a substitute.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/clear_unusable_work_fields.js
 *   node scripts/clear_unusable_work_fields.js --only=books --fields=publishers
 *   node scripts/clear_unusable_work_fields.js --apply
 *
 * Flags:
 *   --apply             actually unset (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --fields=a,b        restrict to these fields (default: all clearable)
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
  NEVER_CLEARED,
  clearableFields,
  planUnusableFieldClearing,
} = require("../unusable_field_plan");

/** How much of a stored value to print beside the work it is on. */
const PREVIEW_CHARS = 60;

/** How many works to list per field before the count speaks for itself. */
const EXAMPLES = 5;

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  fields: args.fields === undefined ? undefined : String(args.fields).split(","),
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

  // A field name none of the selected collections has is a typo, and silently
  // planning nothing for it would look exactly like a clean database.
  const clearable = new Set(selected.flatMap(clearableFields));
  const unknown = (options.fields ?? []).filter((field) => !clearable.has(field));
  if (unknown.length > 0) {
    for (const field of unknown) {
      console.error(
        field in NEVER_CLEARED
          ? `--fields=${field}: ${NEVER_CLEARED[field]}.`
          : `--fields=${field} is not a clearable field of ${selected
              .map((c) => c.type)
              .join(", ")}.`
      );
    }
    console.error(`Clearable here: ${[...clearable].join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? "APPLY MODE: unusable field values will be unset from work documents."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );
  console.log(`Fields: ${(options.fields ?? [...clearable]).join(", ")}`);

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
      "\nOne or more collections were refused. Nothing was written for those."
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
  console.log(`\n=== ${collection.works} ===`);

  const works = await db.collection(collection.works).find().toArray();
  const plan = planUnusableFieldClearing(collection, works, options.fields);

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  report(plan);

  const base = {
    works: plan.totals.works,
    documents: plan.totals.documents,
    values: plan.totals.values,
    fields: Object.fromEntries(
      plan.unset.map((group) => [group.field, group.ids.length])
    ),
    partial: plan.partial.map(({ _id, title, field, kept }) => ({
      _id,
      title,
      field,
      kept,
    })),
  };

  if (!options.apply || plan.totals.values === 0) {
    return { ...base, unset: {} };
  }

  backup(collection.works, works);

  // One `updateMany` per field rather than a bulk write of per-document
  // `$unset`s: within a field the operation is identical, so this is the whole
  // job in at most six round trips. And no `metadataUpdatedDate`: that says
  // when an adapter last had something to say about a work, and removing a
  // value nothing can read is not the adapter saying anything.
  const unset = {};
  for (const group of plan.unset) {
    unset[group.field] = await unsetField(db, collection, group);
  }

  const remaining = await verify(db, collection, plan);
  return { ...base, unset, remaining };
};

const report = (plan) => {
  console.log(
    `  ${plan.totals.works} works, ` +
      `${plan.totals.values} unusable value(s) across ` +
      `${plan.totals.documents} document(s)`
  );

  for (const group of plan.unset) {
    console.log(
      `  ${String(group.ids.length).padStart(5)}  ${group.field}` +
        `${options.apply ? " to unset" : " would be unset"}`
    );
    for (const example of examplesOf(plan, group.field)) {
      console.log(
        `           - ${example.title}: ${preview(example.value)}`
      );
    }
    if (group.ids.length > EXAMPLES) {
      console.log(`           ... and ${group.ids.length - EXAMPLES} more`);
    }
  }

  if (plan.totals.values === 0) {
    console.log("  nothing to unset.");
  }

  if (plan.partial.length > 0) {
    // Not an error, and not a refusal of the collection: the other fields of
    // these documents are cleared as usual. It is a list of values somebody
    // has to decide about, and it is printed in full because it is expected to
    // be empty.
    console.log(
      `\n  ${plan.partial.length} value(s) LEFT ALONE — corrupt, but still ` +
        `holding something an unset would throw away. A ` +
        `$set is a different decision from this one:`
    );
    for (const partial of plan.partial) {
      console.log(
        `      ${partial.title} (${partial._id}): ${partial.field} = ` +
          `${preview(partial.value)}, keeping ${preview(partial.kept)}`
      );
    }
  }
};

/** @type {(db: any, collection: any, group: any) => Promise<number>} */
const unsetField = async (db, collection, group) => {
  const result = await db
    .collection(collection.works)
    .updateMany({ _id: { $in: group.ids } }, { $unset: { [group.field]: "" } });

  console.log(`  unset ${group.field} from ${result.modifiedCount} work(s)`);
  if (result.modifiedCount !== group.ids.length) {
    console.error(
      `  expected ${group.ids.length}, modified ${result.modifiedCount} — ` +
        `something else is writing to ${collection.works}.`
    );
    process.exitCode = 1;
  }
  return result.modifiedCount;
};

/**
 * What is left, asked of the database rather than inferred from the plan: the
 * collection is re-read and re-planned, so anything the run failed to clear
 * turns up the same way it turned up in the first place.
 */
const verify = async (db, collection, plan) => {
  const works = await db.collection(collection.works).find().toArray();
  const after = planUnusableFieldClearing(collection, works, options.fields);

  console.log(
    `  after: ${works.length} works (was ${plan.totals.works}), ` +
      `${after.totals.values} unusable value(s) left, ` +
      `${after.totals.partial} of them left alone deliberately`
  );

  if (works.length !== plan.totals.works) {
    console.error(
      `  WORK COUNT CHANGED: ${plan.totals.works} -> ${works.length}. ` +
        `Restore from the snapshot taken before this run.`
    );
    process.exitCode = 1;
  }
  if (after.totals.values !== 0) {
    console.error(
      `  ${after.totals.values} value(s) this run planned to unset are still ` +
        `there. Re-run to see what they are.`
    );
    process.exitCode = 1;
  }

  return { works: works.length, values: after.totals.values };
};

const summarise = (report) => {
  const totals = Object.values(report).reduce(
    (sum, r) => ({
      documents: sum.documents + (r.documents ?? 0),
      values: sum.values + (r.values ?? 0),
      partial: sum.partial + (r.partial?.length ?? 0),
    }),
    { documents: 0, values: 0, partial: 0 }
  );

  console.log(
    `\n${totals.values} unusable value(s) across ${totals.documents} ` +
      `work document(s) ${options.apply ? "unset" : "would be unset"}.`
  );
  if (totals.partial > 0) {
    console.log(
      `${totals.partial} value(s) were left alone because an unset would have ` +
        `thrown away something usable. See the per-collection output above.`
    );
  }
  if (!options.apply && totals.values > 0) {
    console.log(
      "Take a fresh snapshot with backup_database.js, verify it, then re-run " +
        "with --apply."
    );
  }
};

/** The first few works carrying an unusable value of one field. */
const examplesOf = (plan, field) =>
  plan.documents
    .flatMap((document) =>
      document.fields
        .filter((entry) => entry.field === field)
        .map((entry) => ({ title: document.title, value: entry.value }))
    )
    .slice(0, EXAMPLES);

/**
 * Enough of a value to recognise it. These are cached API metadata — a
 * publisher, a genre, a url — and never anybody's writing, which lives on the
 * entry and review documents this script cannot see.
 */
const preview = (value) => {
  const json = JSON.stringify(value) ?? "undefined";
  return json.length > PREVIEW_CHARS
    ? `${json.slice(0, PREVIEW_CHARS)}...`
    : json;
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
