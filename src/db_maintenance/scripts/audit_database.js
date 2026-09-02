#!/usr/bin/env node
/**
 * @file Read-only audit of the production database.
 *
 * Reports every inconsistency backfill_work_metadata.js and dedupe_works.js
 * can act on, plus the ones that need a human decision. It never writes, and
 * by default it needs no external API keys — only MONGODB_URL.
 *
 * `--verify-shared-refs` is the one thing here that reaches an API, and so the
 * one thing that wants the adapter keys. Works sharing an identity ref are
 * split three ways without asking anyone (../shared_ref_check.js), but which
 * *side* of a collision is misfiled cannot be worked out from the database:
 * both documents look equally plausible. So it retrieves each shared id once
 * — 25 calls against production today — and reports which of the group's
 * titles the id actually names. Off by default because a diagnostic that
 * spends someone else's rate limit every time it is run is a diagnostic that
 * stops being run. #290.
 *
 * Usage:
 *   node scripts/audit_database.js
 *   node scripts/audit_database.js --only=games,books
 *   node scripts/audit_database.js --verify-shared-refs
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
const {
  classifySharedRefs,
  sharedRefReason,
  // `describe` moved there when scripts/repair_shared_refs.js started joining
  // its own reads onto the `id` it writes.
  describeWork: describe,
} = require("../shared_ref_check");
const { implausibleDuration } = require("../duration_plausibility");
const { toSummary, countProblems } = require("../audit_report");
const { verifyIdentities } = require("../load_adapter");

const args = parseArgs(process.argv);

const verifySharedRefs = args["verify-shared-refs"] === true;

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

  // One number for "is anything actually wrong", so a clean run says so
  // instead of leaving a reader to add up ten lines per collection and decide
  // for themselves which of them counted.
  const problems = countProblems(selected, report);
  console.log(
    problems === 0
      ? "\nNo problems found."
      : `\n${problems} problem(s) found across ${selected.length} collection(s).`
  );

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
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
  const implausibleDurations = [];
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

    const implausible = implausibleDuration(collection, work);
    if (implausible) {
      implausibleDurations.push({
        ...describe(work),
        duration: work.duration,
        reason: implausible,
      });
    }

    if (!referencedWorkIds.has(work._id)) orphanWorks.push(describe(work));
  }

  // Three findings out of what used to be one. A group of works under one
  // identity ref is copies of one work, seasons of one show, or one work
  // wearing another's id — and only the last is #290's damage.
  const shared = classifySharedRefs(collection, works);
  const duplicateWorks = shared.duplicates.map(describeGroup);
  const expectedSharedRefs = shared.expected.map(describeGroup);
  const sharedIdentityRefs = shared.collisions.map(describeGroup);

  const identityChecks = verifySharedRefs
    ? await verifyIdentities(collection, shared.collisions)
    : [];

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
    implausibleDurations,
    duplicateWorks,
    expectedSharedRefs,
    sharedIdentityRefs,
    identityChecks,
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

const describeGroup = ({ key, ref, works }) => ({
  apiRef: key,
  ref,
  count: works.length,
  works: works.map(describe),
});

const printSummary = (collection, result) => {
  const { problems, notes } = toSummary(collection, result);

  console.log(`\n=== ${collection.works} ===`);
  console.log(
    `  works: ${result.works}, entries: ${result.entries}, ` +
      `reviews: ${result.reviews}`
  );

  for (const line of problems) {
    console.log(`  ${String(line.count).padStart(5)}  ${line.label}`);
  }

  // Below the problems and marked, because these are supported states rather
  // than damage — printed in the same list, the user-authored entries were
  // read as broken ones. See ../audit_report.js.
  console.log("  --- not problems, for information ---");
  for (const line of notes) {
    console.log(`  ${String(line.count).padStart(5)}  ${line.label}`);
  }

  for (const finding of result.implausibleDurations) {
    console.log(`  e.g. impossible duration: ${finding.title}: ${finding.reason}`);
  }

  printSharedRefs(collection, result);

  const examples = result.missingFields.slice(0, 5);
  if (examples.length > 0) {
    console.log("  e.g. missing:");
    for (const e of examples) {
      console.log(`    - ${e.title}: ${e.fields.join(", ")}`);
    }
  }
};

/**
 * The collision groups in full, and what the API said about each — every one
 * of them rather than a sample, because a count of collisions is not something
 * anyone can act on and the pairs are the whole finding.
 */
const printSharedRefs = (collection, result) => {
  const reason = sharedRefReason(collection);
  if (reason && result.expectedSharedRefs.length > 0) {
    console.log(`  (${result.expectedSharedRefs.length} shared ids: ${reason})`);
  }

  if (result.sharedIdentityRefs.length === 0) return;

  if (!verifySharedRefs) {
    console.log(
      `  shared ids, unverified — pass --verify-shared-refs to ask ` +
        `${collection.retrievePrefix} which work each one names:`
    );
    for (const group of result.sharedIdentityRefs) {
      console.log(
        `    - ${group.apiRef}: ${group.works.map((w) => w.title).join(" | ")}`
      );
    }
    return;
  }

  console.log(`  shared ids, as ${collection.retrievePrefix} reports them:`);
  for (const check of result.identityChecks) {
    if (check.error) {
      console.log(`    - ${check.apiRef}: could not be asked (${check.error})`);
      continue;
    }
    console.log(`    - ${check.apiRef} names "${check.apiTitle}"`);
    const named = check.matches.map((w) => `${w.title} (${w.id})`);
    console.log(`        it is:     ${named.join(", ") || "none of these"}`);
    console.log(
      `        it is not: ${check.mismatches
        .map((w) => `${w.title} (${w.id})`)
        .join(", ")}`
    );
  }
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
