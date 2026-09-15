#!/usr/bin/env node
/**
 * @file Deletes cached works no entry points at, and review documents holding
 * nothing. #339.
 *
 * Two populations, filed together because they are the same claim — the
 * document exists and no code path the site has can put it in front of a
 * reader — and split by `--only=works,reviews` because they are two different
 * arguments and the second is a bigger ask than the first. Run and review them
 * separately. ../unreachable_document_plan.js decides both, and is unit
 * tested; this file does the reading, the printing and the writing.
 *
 * **The works half needs no exception to CLAUDE.md's rule**: a work
 * collection is exactly what these scripts are allowed to write to. What it
 * needs is care about the claim. `auditCollection` in ./audit_database.js
 * counts a work unreferenced by asking one entry collection, which is right
 * for a note in a report and too weak for a delete, so this asks all four and
 * prints how many works only a foreign collection reaches. And a work in an
 * open collision group — ../title_year_check.js's (#319, #322) or
 * ../shared_ref_check.js's — is skipped and printed rather than deleted:
 * several of those groups are a live document beside an unreachable one, and
 * the unreachable one is the evidence for a decision nobody has made. A prune
 * that took it would settle the question by destroying it.
 *
 * **The reviews half is the second exception to that rule**, and the argument
 * is narrower than ./prune_orphan_reviews.js's — the only exception until now
 * — rather than the same one again. That script deletes notes **no code path
 * can reach**: the entry is gone, and a review is only ever looked up by
 * `entryRef`. This deletes notes **a code path reaches and finds empty**. The
 * entry is right there, `getReview` in ../../api/controllers/reviews.js
 * answers with the document, and the panel renders
 * `review?.data?.text || '*None yet...*'` — the same placeholder it draws when
 * there is no document at all.
 *
 * That an empty string is a real value is not in dispute and is not the
 * argument. It is deliberately real: #213 is the bug that comes of reading an
 * absent `review` as an instruction to clear one, and `updateEntry_` and
 * `createEntry` both go out of their way to keep "absent" and "empty" apart.
 * The argument is the narrower one that **deleting the document is invisible
 * to every reader and to the next save**, which was verified rather than
 * assumed:
 *
 *   - `updateEntry_` writes `existingReview ? updateByRef_(...) : create_(...)`
 *     — so the document comes back on the next save whether or not it is there
 *     now, with the same `entryRef` and the same text.
 *   - `getReview` answers `{}` for a missing document, which is what the `?.`
 *     in the panel already turns into the placeholder.
 *   - `findReviews` in ../../api/controllers/export.js filters on
 *     `review?.text`, so an empty note is left out of an export either way.
 *   - `changedFields` in ../../api/utils/revision_history.js calls `''` and
 *     `undefined` the same absence, so the version list draws the same
 *     history and records no version it would not have recorded.
 *
 * Those four are pinned by tests in ../../api/controllers/entries.test.js,
 * which drive the real handler and compare a save over an empty note against
 * the same save after a prune.
 *
 * One difference survives, and is the reason this half is a separate flag and
 * the repository owner's call rather than a detail: `writeForm` in
 * ../../frontend/_includes/js/utils/entry_form_io.js restores a snapshot's
 * note only `if (snapshot.review !== undefined)`. A version recorded *after* a
 * prune has no `review` key, so restoring it leaves whatever is in the
 * textarea instead of emptying it. It takes an entry whose note was empty at
 * the version being restored and is not empty now, and it changes a restore
 * rather than a save. Nothing else in the tree can tell the two states apart.
 *
 * Reviews whose *entry* is gone are counted and left alone. They are
 * ./prune_orphan_reviews.js's population, and this file's argument — "a save
 * writes it again" — is not available for an entry that no longer exists. One
 * script per claim.
 *
 * Neither half touches `*Entries`, so no user override and no live note is
 * reachable from here, and everything either half deletes is restorable by
 * `_id` from the snapshot taken immediately before the run.
 *
 * Environment (../.env): MONGODB_URL. No API keys needed.
 *
 * Usage:
 *   node scripts/prune_unreachable_documents.js
 *   node scripts/prune_unreachable_documents.js --only=works
 *   node scripts/prune_unreachable_documents.js --only=reviews --types=books
 *   node scripts/prune_unreachable_documents.js --only=works --apply
 *
 * Flags:
 *   --apply             actually delete (default: dry run)
 *   --only=works,reviews  which half to run (default: both)
 *   --types=a,b         restrict to these types (films, tv, games, books)
 *   --list              print every document, not just the first few
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
  displayTitle,
  parseArgs,
} = require("../work_collections");
const { classifyTitleYearGroups } = require("../title_year_check");
const { classifySharedRefs } = require("../shared_ref_check");
const {
  WORK_REASONS,
  REVIEW_REASONS,
  planUnreachableWorks,
  planEmptyReviewRemoval,
} = require("../unreachable_document_plan");

const HALVES = ["works", "reviews"];

/** How many documents a dry run names before it stops, without `--list`. */
const PRINT_LIMIT = 10;

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  list: args.list === true,
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

let client;

const main = async () => {
  const halves = selectHalves(args.only);
  if (halves.length === 0) {
    console.error(
      `--only=${args.only} matched nothing. Valid halves: ${HALVES.join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  const selected = selectCollections(args.types);
  if (selected.length === 0) {
    console.error(
      `--types=${args.types} matched nothing. Valid types: ${COLLECTIONS.map(
        (c) => c.type
      ).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? `APPLY MODE: unreachable documents will be deleted (${halves.join(", ")}).`
      : `DRY RUN: nothing will be written (${halves.join(
          ", "
        )}). Re-run with --apply to commit.`
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  // Every entry collection, read once. A work is reached through **any**
  // entry's `workRef`, so deciding a film unreachable means having the book
  // entries in hand too — see ../unreachable_document_plan.js.
  const entriesByCollection = Object.fromEntries(
    await Promise.all(
      COLLECTIONS.map(async (collection) => [
        collection.entries,
        await db.collection(collection.entries).find().toArray(),
      ])
    )
  );
  console.log(
    `\nEntries read: ${COLLECTIONS.map(
      (c) => `${c.entries} ${entriesByCollection[c.entries].length}`
    ).join(", ")}`
  );

  const report = {};
  let blocked = false;

  for (const collection of selected) {
    report[collection.type] = {};

    if (halves.includes("works")) {
      const result = await pruneWorks(db, collection, entriesByCollection);
      report[collection.type].works = result;
      if (result.blocked) blocked = true;
    }

    if (halves.includes("reviews")) {
      const result = await pruneReviews(
        db,
        collection,
        entriesByCollection[collection.entries]
      );
      report[collection.type].reviews = result;
      if (result.blocked) blocked = true;
    }
  }

  printTotals(halves, report);

  if (blocked) {
    console.error(
      "\nOne or more collections were refused, and nothing was deleted for " +
        "those. A refusal means what was read is what a failed read looks " +
        "like — check the connection and the collection names before " +
        "re-running."
    );
    process.exitCode = 1;
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${args.json}`);
  }

  await client.close();
};

///////////////////////////////////////////////////////////////////////////////
// Works

const pruneWorks = async (db, collection, entriesByCollection) => {
  console.log(`\n=== ${collection.works} ===`);

  const works = await db.collection(collection.works).find().toArray();
  const ownEntries = entriesByCollection[collection.entries];

  const plan = planUnreachableWorks({
    works,
    entriesByCollection,
    ownEntryCollection: collection.entries,
    protectedWorkIds: protectedWorkIds(collection, works, ownEntries),
  });

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  console.log(
    `  ${plan.works} work(s), ${plan.reachable} reached by an entry, ` +
      `${plan.unreachable.length} reached by none`
  );
  // Printed whether or not it is zero: zero is the evidence that the wider
  // question was asked, and the audit's own count cannot ask it.
  console.log(
    `  ${plan.crossCollection.length} reached only by an entry in another ` +
      `type's collection`
  );
  for (const work of plan.crossCollection) {
    console.log(`      ${work._id}  ${displayTitle(work)}`);
  }

  if (plan.skipped.length > 0) {
    console.log(`\n  SKIPPED — ${plan.skipped.length} unreachable, left alone:`);
    for (const { work, reason } of plan.skipped) {
      console.log(`      ${work._id}  ${displayTitle(work)}  — ${reason}`);
    }
  }

  console.log(
    `\n  TO DELETE — ${plan.deletable.length}: ${WORK_REASONS.unreachable}`
  );
  printSome(plan.deletable, (work) =>
    `      ${work._id}  ${displayTitle(work)}  [${refsOf(work)}]`
  );

  const base = {
    works: plan.works,
    reachable: plan.reachable,
    unreachable: plan.unreachable.length,
    crossCollection: plan.crossCollection.map((w) => String(w._id)),
    skipped: plan.skipped.map(({ work, reason }) => ({
      id: String(work._id),
      title: displayTitle(work),
      reason,
    })),
    deletable: plan.deletable.length,
    ids: plan.deletable.map((w) => String(w._id)),
  };

  if (!options.apply || plan.deletable.length === 0) {
    return { ...base, deleted: 0 };
  }

  backup(collection.works, works);
  const result = await db
    .collection(collection.works)
    .deleteMany({ _id: { $in: plan.deletable.map((w) => w._id) } });

  console.log(`  deleted ${result.deletedCount} work(s)`);
  return { ...base, deleted: result.deletedCount };
};

/**
 * The works two other checks have an open question about, as
 * `[{ id, reason }]`.
 *
 * Both checks, and not only the title-and-year one, because the hazard is the
 * same from either side: a group of documents a human has yet to rule on, in
 * which the unreachable member is half the evidence. ../title_year_check.js
 * finds one work filed under two ids; ../shared_ref_check.js finds two
 * documents under one id whose titles agree. The tv shows that share a show id
 * **by design** — separate seasons — are not an open question and are not
 * protected here.
 *
 * All three title-and-year buckets count. `undecided` is the largest and the
 * weakest, and it is still a pair a reader may yet have to look at.
 */
const protectedWorkIds = (collection, works, entries) => {
  const titleYear = classifyTitleYearGroups(collection, works, entries);
  const shared = classifySharedRefs(collection, works);

  return [
    ...[
      ...titleYear.duplicates,
      ...titleYear.unidentified,
      ...titleYear.undecided,
    ].flatMap((group) =>
      group.works.map((work) => ({
        id: work.id,
        reason: `${WORK_REASONS.titleYearGroup} [${group.key}]`,
      }))
    ),
    ...shared.duplicates.flatMap((group) =>
      group.works.map((work) => ({
        id: work._id,
        reason: `${WORK_REASONS.sharedIdentityRef} [${group.key}]`,
      }))
    ),
  ];
};

/** The apiRefs a work carries, for a line that has to fit on one row. */
const refsOf = (work) =>
  (Array.isArray(work?.apiRefs) ? work.apiRefs : [])
    .map((ref) => (typeof ref === "string" ? ref : `${ref?.name}__${ref?.ref}`))
    .join(" ") || "no apiRef";

///////////////////////////////////////////////////////////////////////////////
// Reviews

const pruneReviews = async (db, collection, entries) => {
  console.log(`\n=== ${collection.reviews} ===`);

  const reviews = await db.collection(collection.reviews).find().toArray();
  const plan = planEmptyReviewRemoval(entries, reviews);

  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  console.log(
    `  ${plan.reviews} review(s): ${plan.withText.length} ${REVIEW_REASONS.withText}, ` +
      `${plan.deletable.length} empty, ${plan.orphaned.length} orphaned`
  );

  if (plan.orphaned.length > 0) {
    console.log(`\n  SKIPPED — ${plan.orphaned.length}: ${REVIEW_REASONS.orphaned}`);
  }

  console.log(
    `\n  TO DELETE — ${plan.deletable.length}: ${REVIEW_REASONS.empty}`
  );
  printSome(plan.deletable, (review) =>
    `      ${review._id}  (entryRef ${review.entryRef})`
  );

  const base = {
    reviews: plan.reviews,
    withText: plan.withText.length,
    orphaned: plan.orphaned.length,
    deletable: plan.deletable.length,
    ids: plan.deletable.map((r) => String(r._id)),
  };

  if (!options.apply || plan.deletable.length === 0) {
    return { ...base, deleted: 0 };
  }

  backup(collection.reviews, reviews);
  const result = await db
    .collection(collection.reviews)
    .deleteMany({ _id: { $in: plan.deletable.map((r) => r._id) } });

  console.log(`  deleted ${result.deletedCount} review(s)`);
  return { ...base, deleted: result.deletedCount };
};

///////////////////////////////////////////////////////////////////////////////

/**
 * The halves to run. `--only` here names the half rather than the type —
 * `--types` is what the other scripts spell `--only` — because the two halves
 * are the thing a reader of this script wants to separate, and a run of one of
 * them across all four types is the reviewable unit.
 */
const selectHalves = (only) =>
  only === undefined || only === true
    ? HALVES
    : HALVES.filter((half) => String(only).split(",").includes(half));

/**
 * A dry run that names 1,869 documents is a dry run nobody reads, so the list
 * is cut short unless `--list` asks for all of it. `--json` always carries
 * every id.
 */
const printSome = (documents, line) => {
  const shown = options.list ? documents : documents.slice(0, PRINT_LIMIT);
  for (const document of shown) console.log(line(document));
  if (shown.length < documents.length) {
    console.log(
      `      ... and ${documents.length - shown.length} more ` +
        `(--list for all of them, --json=path for the ids)`
    );
  }
};

const printTotals = (halves, report) => {
  const rows = Object.values(report);

  if (halves.includes("works")) {
    const sum = (field) => total(rows, "works", field);
    console.log(
      `\n${sum("deletable")} work(s) to delete, ` +
        `${sum("skipped")} left alone in an open collision group, ` +
        `${sum("reachable")} reached by an entry.`
    );
  }

  if (halves.includes("reviews")) {
    const sum = (field) => total(rows, "reviews", field);
    console.log(
      `${sum("deletable")} empty review(s) to delete, ` +
        `${sum("withText")} holding a note, ` +
        `${sum("orphaned")} left to prune_orphan_reviews.js.`
    );
  }
};

/**
 * One field of one half, added up across the collections.
 *
 * A count or a list of what was counted, because the report carries both
 * shapes — `deletable` is a number and `skipped` is the works themselves, so
 * that `--json` says which ones were refused and why. Adding the second with
 * `+` stringified it: the totals line read "0[object Object],[object
 * Object]..." and still called itself a number of works.
 */
const total = (rows, half, field) =>
  rows.reduce((sum, row) => {
    const value = row[half]?.[field];
    return sum + (Array.isArray(value) ? value.length : (value ?? 0));
  }, 0);

/**
 * The whole collection as it stands, beside the snapshot CLAUDE.md asks for
 * separately. This is the same per-collection dump ./prune_orphan_reviews.js
 * and ./dedupe_works.js take, and it is not a substitute for
 * `scripts/backup_database.js` — take that first.
 */
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
