#!/usr/bin/env node
/**
 * @file Backfills and refreshes the cached work metadata (issue #83).
 *
 * For every document in films/tvShows/games/books it re-runs the same
 * adapter the API uses, then fills in what is missing and refreshes what is
 * stale.
 *
 * User overrides are never touched: they live on the *entry* documents
 * (`entry.overrides`), and this script only ever writes to work documents.
 *
 * It is a dry run unless you pass --apply, and it takes a JSON backup of every
 * collection it is about to write to.
 *
 * The decisions it makes live in ../work_metadata_merge.js and are unit tested.
 *
 * Environment (../.env): MONGODB_URL, plus the keys the adapters
 * need for the types you are refreshing — TMDB_API_KEY (films, tv),
 * TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET (games), GOOGLE_API_KEY (books,
 * optional but strongly recommended for rate limits).
 *
 * Usage:
 *   node scripts/backfill_work_metadata.js --only=games --missing-only
 *   node scripts/backfill_work_metadata.js --only=games --missing-only --apply
 *   node scripts/backfill_work_metadata.js --max-age-days=365 --limit=50
 *
 * Flags:
 *   --apply             actually write (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --missing-only      only touch works with missing/corrupt metadata
 *   --max-age-days=N    in full-refresh mode, skip works refreshed within N
 *                       days (default 180)
 *   --force             ignore --max-age-days
 *   --limit=N           stop after N works per collection
 *   --delay-ms=N        override the per-type pause between API calls
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put backups (default ../backups)
 */
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  findApiRef,
  isEmptyValue,
  sleep,
  parseArgs,
  selectCollections,
} = require("../work_collections");
const { hasGaps, mergeWork } = require("../work_metadata_merge");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  missingOnly: args["missing-only"] === true,
  force: args.force === true,
  maxAgeMs: (parseInt(args["max-age-days"]) || 180) * 24 * 60 * 60 * 1000,
  limit: parseInt(args.limit) || Infinity,
  delayMs:
    args["delay-ms"] === undefined ? undefined : parseInt(args["delay-ms"]),
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

/** Built inside main() so the module can be required without MONGODB_URL. */
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
      ? "APPLY MODE: the database will be modified."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  for (const collection of selected) {
    report[collection.type] = await backfillCollection(db, collection);
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${args.json}`);
  }

  await client.close();
};

const backfillCollection = async (db, collection) => {
  console.log(`\n=== ${collection.works} ===`);

  const adapter = loadAdapter(collection);
  if (!adapter) return { skipped: "adapter could not be loaded" };

  const works = await db.collection(collection.works).find().toArray();
  const candidates = works.filter((work) => needsRefresh(collection, work));
  const selected = candidates.slice(0, options.limit);

  console.log(
    `  ${works.length} works, ${candidates.length} need attention, ` +
      `processing ${selected.length}`
  );

  if (selected.length === 0) return { works: works.length, processed: 0 };

  if (options.apply) backup(collection.works, works);

  const delayMs = options.delayMs ?? collection.defaultDelayMs;
  const changes = [];
  const failures = [];
  const unrefreshable = [];
  let unchanged = 0;

  for (const [index, work] of selected.entries()) {
    const apiRef = findApiRef(work.apiRefs, collection.retrievePrefix);
    if (!apiRef) {
      unrefreshable.push(describe(work));
      continue;
    }

    if (index > 0) await sleep(delayMs);

    const result = await adapter.retrieve(apiRef);
    if (result.isErr()) {
      const error = describeError(result.error);
      console.log(`  ! ${title(work)} (${apiRef}): ${error}`);
      failures.push({ ...describe(work), error });
      continue;
    }

    const { updates, notes } = mergeWork(collection, work, result.value, options);

    if (Object.keys(updates).length === 0) {
      unchanged += 1;
      if (options.apply) await touch(db, collection, work);
      continue;
    }

    console.log(`  ~ ${title(work)}: ${summarizeUpdates(work, updates)}`);
    for (const note of notes) console.log(`      note: ${note}`);

    if (options.apply) {
      await db
        .collection(collection.works)
        .updateOne(
          { _id: work._id },
          { $set: { ...updates, metadataUpdatedDate: Date.now() } }
        );
    }

    changes.push({ ...describe(work), updates, notes });
  }

  console.log(
    `  ${changes.length} ${options.apply ? "updated" : "would be updated"}, ` +
      `${unchanged} already current, ${failures.length} failed, ` +
      `${unrefreshable.length} without a ${collection.retrievePrefix}__ ref`
  );

  return {
    works: works.length,
    processed: selected.length,
    changes,
    failures,
    unrefreshable,
    unchanged,
  };
};

/**
 * Lazily required: each adapter reads (and the games one throws on) its own
 * env vars at load time, so requiring all four would make a films-only run
 * depend on Twitch credentials.
 */
const loadAdapter = (collection) => {
  try {
    return require(collection.adapterModule);
  } catch (e) {
    console.log(
      `  skipping ${collection.works}: could not load adapter (${
        e?.message ?? e
      })`
    );
    return undefined;
  }
};

const needsRefresh = (collection, work) => {
  if (options.missingOnly) return hasGaps(collection, work);
  if (options.force) return true;
  const refreshedAt = work.metadataUpdatedDate;
  return (
    typeof refreshedAt !== "number" ||
    Date.now() - refreshedAt > options.maxAgeMs
  );
};

/** Marks a work as checked so an interrupted run can be resumed cheaply. */
const touch = (db, collection, work) =>
  db
    .collection(collection.works)
    .updateOne({ _id: work._id }, { $set: { metadataUpdatedDate: Date.now() } });

const backup = (collectionName, documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${collectionName}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`  backed up ${documents.length} documents to ${file}`);
};

const title = (work) =>
  work.englishTranslatedTitle ?? work.originalTitle ?? work._id;

const describe = (work) => ({
  id: work._id,
  title: title(work),
  apiRefs: work.apiRefs,
});

const describeError = (error) =>
  typeof error === "string" ? error : error?.message ?? JSON.stringify(error);

const summarizeUpdates = (work, updates) =>
  Object.entries(updates)
    .map(([field, value]) =>
      isEmptyValue(work[field])
        ? `+${field}=${preview(value)}`
        : `${field}: ${preview(work[field])} -> ${preview(value)}`
    )
    .join(", ");

const preview = (value) => {
  const text = Array.isArray(value)
    ? value.map(preview).join("|")
    : String(value && typeof value === "object" ? JSON.stringify(value) : value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
