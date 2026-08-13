#!/usr/bin/env node
/**
 * @file Read-only audit of the production database.
 *
 * Reports every inconsistency backfill_work_metadata.js and dedupe_works.js
 * can act on, plus the ones that need a human decision. It never writes, and
 * it needs no external API keys — only MONGODB_URL.
 *
 * Usage:
 *   node scripts/audit_database.js
 *   node scripts/audit_database.js --only=games,books
 *   node scripts/audit_database.js --json=./audit.json
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  parseApiRef,
  isEmptyValue,
  selectCollections,
  parseArgs,
} = require("../work_collections");
const {
  expectedFields,
  corruptFieldsOf,
  isMissingPlaytimeLink,
} = require("../work_metadata_merge");
const { groupWorksByApiRef } = require("../work_dedupe_plan");

const args = parseArgs(process.argv);

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

  const report = {};
  for (const collection of selected) {
    report[collection.type] = await auditCollection(db, collection);
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${args.json}`);
  }

  await client.close();
};

const auditCollection = async (db, collection) => {
  const works = await db.collection(collection.works).find().toArray();
  const entries = await db.collection(collection.entries).find().toArray();
  const reviews = await db.collection(collection.reviews).find().toArray();

  const workIds = new Set(works.map((w) => w._id));
  const entryIds = new Set(entries.map((e) => e._id));
  const referencedWorkIds = new Set(
    entries.map((e) => e.workRef).filter((ref) => ref)
  );

  const noApiRef = [];
  const legacyObjectApiRefs = [];
  const missingFields = [];
  const corruptFields = [];
  const gamesMissingPlaytimeLink = [];
  const orphanWorks = [];

  for (const work of works) {
    if (!hasRetrieveRef(collection, work)) noApiRef.push(describe(work));

    if (
      Array.isArray(work.apiRefs) &&
      work.apiRefs.some((ref) => parseApiRef(ref)?.flat === false)
    ) {
      legacyObjectApiRefs.push(describe(work));
    }

    const missing = expectedFields(collection).filter((field) =>
      isEmptyValue(work[field])
    );
    if (missing.length > 0) {
      missingFields.push({ ...describe(work), fields: missing });
    }

    const corrupt = corruptFieldsOf(collection, work);
    if (corrupt.length > 0) {
      corruptFields.push({ ...describe(work), fields: corrupt });
    }

    if (isMissingPlaytimeLink(collection, work)) {
      gamesMissingPlaytimeLink.push(describe(work));
    }

    if (!referencedWorkIds.has(work._id)) orphanWorks.push(describe(work));
  }

  const duplicateWorks = [...groupWorksByApiRef(collection, works).entries()]
    .filter(([, group]) => group.length > 1)
    .map(([apiRef, group]) => ({
      apiRef,
      count: group.length,
      works: group.map(describe),
    }));

  const entriesWithoutWorkRef = entries
    .filter((e) => !e.workRef)
    .map((e) => ({ id: e._id, userId: e.userId, status: e.status }));

  const entriesWithDanglingWorkRef = entries
    .filter((e) => e.workRef && !workIds.has(e.workRef))
    .map((e) => ({ id: e._id, userId: e.userId, workRef: e.workRef }));

  // A review is only ever found by `entryRef`, so one whose entry is gone is
  // unreachable rather than deleted. The text is a user's private note and
  // stays out of the report; its length is enough to size what is left behind.
  const orphanReviews = reviews
    .filter((r) => !r.entryRef || !entryIds.has(r.entryRef))
    .map((r) => ({
      id: r._id,
      entryRef: r.entryRef ?? null,
      textLength: r.text?.length ?? 0,
    }));

  const result = {
    works: works.length,
    entries: entries.length,
    reviews: reviews.length,
    noApiRef,
    legacyObjectApiRefs,
    missingFields,
    corruptFields,
    gamesMissingPlaytimeLink,
    duplicateWorks,
    orphanWorks,
    entriesWithoutWorkRef,
    entriesWithDanglingWorkRef,
    orphanReviews,
  };

  printSummary(collection, result);
  return result;
};

const hasRetrieveRef = (collection, work) =>
  Array.isArray(work.apiRefs) &&
  work.apiRefs.some(
    (ref) => parseApiRef(ref)?.name === collection.retrievePrefix
  );

const describe = (work) => ({
  id: work._id,
  title: work.englishTranslatedTitle ?? work.originalTitle ?? "(untitled)",
  apiRefs: work.apiRefs,
});

const printSummary = (collection, r) => {
  console.log(`\n=== ${collection.works} ===`);
  console.log(
    `  works: ${r.works}, entries: ${r.entries}, reviews: ${r.reviews}`
  );
  const lines = [
    [`no ${collection.retrievePrefix}__ ref (cannot be refreshed)`, r.noApiRef],
    ["apiRefs still stored as objects", r.legacyObjectApiRefs],
    ["missing metadata fields", r.missingFields],
    ["corrupt field values", r.corruptFields],
    ...(collection.type === "games"
      ? [["playtime with nothing to link it to", r.gamesMissingPlaytimeLink]]
      : []),
    ["duplicate works sharing an apiRef", r.duplicateWorks],
    ["works no entry points at", r.orphanWorks],
    ["entries with no workRef", r.entriesWithoutWorkRef],
    ["entries with a dangling workRef", r.entriesWithDanglingWorkRef],
    ["reviews with no entry", r.orphanReviews],
  ];
  for (const [label, items] of lines) {
    console.log(`  ${String(items.length).padStart(5)}  ${label}`);
  }

  const examples = r.missingFields.slice(0, 5);
  if (examples.length > 0) {
    console.log("  e.g. missing:");
    for (const e of examples) {
      console.log(`    - ${e.title}: ${e.fields.join(", ")}`);
    }
  }
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
