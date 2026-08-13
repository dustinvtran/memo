#!/usr/bin/env node
/**
 * @file Creates the indexes the site's queries need (issue #108).
 *
 * Nothing in the repository created an index, so every query was a collection
 * scan. Which indexes are wanted, and why each of them is, is declared in
 * ../index_plan.js; this script reads what the database already has, compares
 * the two, and creates the difference.
 *
 * **Re-running is a no-op.** `createIndexes` is idempotent for an identical
 * spec, and the specs here are named the way MongoDB names them by default
 * (`entryRef_1`), so an index made by hand at the mongosh prompt is recognised
 * as the same index rather than collided with. The dry run says which ones
 * already exist and which ones it would create.
 *
 * Indexes are metadata: this writes no documents and touches no user data, so
 * it needs no backup. It is still a dry run unless you pass --apply, because
 * building an index on a live collection costs I/O and, in the one case below,
 * can fail.
 *
 * **The one that can fail is `users.username`, which is unique** — it closes
 * the check-then-write race in the rename path (#98). A unique index refuses
 * to build if duplicate values already exist, so the duplicates are looked for
 * first and reported by hand; the dry run tells you whether the unique index
 * would succeed before you commit to it. Two users with no username at all
 * count as duplicates: MongoDB indexes a missing field as null.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/ensure_indexes.js
 *   node scripts/ensure_indexes.js --apply
 *   node scripts/ensure_indexes.js --only=entryRevisions,users
 *
 * Flags:
 *   --apply             actually create the indexes (default: dry run)
 *   --only=a,b          restrict to these collections (default: all of them)
 *   --json=path         write a machine-readable report
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { parseArgs } = require("../work_collections");
const {
  DESIRED_INDEXES,
  indexName,
  planIndexes,
  duplicateValues,
  uniqueIndexes,
} = require("../index_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  only:
    args.only === undefined || args.only === true
      ? undefined
      : String(args.only).split(","),
  json: typeof args.json === "string" ? args.json : undefined,
};

let client;

const main = async () => {
  const desired = options.only
    ? DESIRED_INDEXES.filter((index) => options.only.includes(index.collection))
    : DESIRED_INDEXES;

  if (desired.length === 0) {
    console.error(
      `--only=${args.only} matched nothing. Collections with indexes: ` +
        `${[...new Set(DESIRED_INDEXES.map((i) => i.collection))].join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? "APPLY MODE: missing indexes will be created."
      : "DRY RUN: nothing will be created. Re-run with --apply to commit."
  );

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }
  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const plan = planIndexes(desired, await readExistingIndexes(db, desired));
  const blockers = await findUniqueBlockers(db, plan.create);

  printPlan(plan, blockers);

  const created = options.apply
    ? await createIndexes(db, plan.create, blockers)
    : [];

  if (options.json) {
    fs.writeFileSync(
      options.json,
      JSON.stringify({ ...plan, blockers, created }, null, 2)
    );
    console.log(`\nFull report written to ${options.json}`);
  }

  if (plan.conflicting.length > 0 || blockers.length > 0) process.exitCode = 1;

  await client.close();
};

/**
 * What each collection already has, keyed by collection name. A collection
 * that doesn't exist yet is left out rather than recorded as empty — `.indexes()`
 * throws on one — which the planner reads as "has nothing", the same answer.
 * @type {(db: import('mongodb').Db, desired: object[]) => Promise<Record<string, object[]>>}
 */
const readExistingIndexes = async (db, desired) => {
  const names = [...new Set(desired.map((index) => index.collection))];
  const live = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      ({ name }) => name
    )
  );

  const existing = {};
  for (const name of names) {
    if (!live.has(name)) {
      console.warn(`Warning: ${name} is not a collection in this database.`);
      continue;
    }
    existing[name] = await db.collection(name).indexes();
  }
  return existing;
};

/**
 * The duplicates that would make a unique index fail to build. Only the
 * indexes we are about to create are checked — an existing unique index has
 * already proved there are none.
 *
 * The values themselves are usernames, which are public, so printing them is
 * how a human finds the two accounts to reconcile. Nothing else here is
 * unique, so nothing private is read.
 *
 * @type {(db: import('mongodb').Db, create: object[]) => Promise<object[]>}
 */
const findUniqueBlockers = async (db, create) => {
  const blockers = [];
  for (const index of uniqueIndexes(create)) {
    const [field] = Object.keys(index.key);
    const documents = await db
      .collection(index.collection)
      .find({}, { projection: { [field]: 1 } })
      .toArray();
    const duplicates = duplicateValues(documents, field);
    if (duplicates.length > 0) {
      blockers.push({ collection: index.collection, field, duplicates });
    }
  }
  return blockers;
};

/**
 * An index blocked by duplicates is skipped; the rest are still worth having,
 * including the other indexes on the same collection — duplicate usernames say
 * nothing about `users.userId`.
 */
const isBlocked = (index, blockers) =>
  blockers.some(
    (blocker) =>
      blocker.collection === index.collection &&
      blocker.field === Object.keys(index.key)[0]
  );

const createIndexes = async (db, create, blockers) => {
  const created = [];
  for (const index of create) {
    if (isBlocked(index, blockers)) continue;
    const name = indexName(index.key);
    await db
      .collection(index.collection)
      .createIndexes([{ key: index.key, name, ...(index.options ?? {}) }]);
    console.log(`  created ${index.collection}.${name}`);
    created.push({ collection: index.collection, name });
  }
  console.log(`\nCreated ${created.length} index(es).`);
  return created;
};

const printPlan = (plan, blockers) => {
  console.log(
    `\n${plan.satisfied.length} index(es) already exist, ` +
      `${plan.create.length} would be created, ` +
      `${plan.conflicting.length} conflict.`
  );

  if (plan.satisfied.length > 0) {
    console.log("\nAlready there:");
    for (const index of plan.satisfied) {
      console.log(`  ${index.collection}.${indexName(index.key)}`);
    }
  }

  if (plan.create.length > 0) {
    console.log(`\n${options.apply ? "Creating" : "Would create"}:`);
    for (const index of plan.create) {
      const unique = index.options?.unique === true ? " (unique)" : "";
      const blocked = isBlocked(index, blockers) ? "  [BLOCKED, see below]" : "";
      console.log(
        `  ${index.collection}.${indexName(index.key)}${unique}${blocked}`
      );
      console.log(`      for ${index.why}`);
    }
  }

  if (plan.conflicting.length > 0) {
    console.log(
      "\nConflicts — an index already there is close enough to collide with " +
        "the one wanted, and creating anything cannot fix it. Drop the " +
        "existing one and re-run:"
    );
    for (const index of plan.conflicting) {
      console.log(`  ${index.collection}.${indexName(index.key)}: ${index.reason}`);
      console.log(
        `      db.${index.collection}.dropIndex("${index.existing.name}")`
      );
    }
  }

  for (const { collection, field, duplicates } of blockers) {
    const total = duplicates.reduce((sum, d) => sum + d.ids.length, 0);
    console.log(
      `\nA unique index on ${collection}.${field} cannot be built: ` +
        `${duplicates.length} value(s) are held by ${total} documents. ` +
        "Reconcile these first — the index is skipped until you do."
    );
    for (const { value, ids } of duplicates) {
      const label = value === null ? "(no value)" : JSON.stringify(value);
      console.log(`  ${label}: ${ids.join(", ")}`);
    }
  }

  if (!options.apply && plan.create.length > 0) {
    console.log(
      "\nNothing was written. Re-run with --apply once the above looks right."
    );
  }
};

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await client?.close();
});
