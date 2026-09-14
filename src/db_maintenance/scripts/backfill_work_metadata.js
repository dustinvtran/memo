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
 * The two modes answer different questions. `--missing-only` fills gaps and
 * never overwrites, and every run applied so far has been one of those — so by
 * construction it cannot fix a work that is complete and wrong. A release date
 * stored while it was still TBD, or a playtime that has since been
 * re-estimated, is only ever corrected by an age-based run, which is what
 * `--max-age-days` selects and what #333 is about. That run *overwrites*,
 * which is why the guards in ../work_metadata_merge.js matter far more to it
 * than they ever did to a gap fill.
 *
 * Which works a run picks, and in what order, is ../metadata_refresh_plan.js:
 * longest-unchecked first, so that `--limit` makes a crawl a queue that can be
 * spread over many runs against a daily rate limit rather than an arbitrary
 * slice. `.github/workflows/refresh_metadata.yml` is that schedule (#3).
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
 *   --max-age-days=N    in full-refresh mode, skip works checked within N
 *                       days (default 180)
 *   --force             ignore --max-age-days
 *   --limit=N           stop after N works per collection
 *   --delay-ms=N        override the per-type pause between API calls
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put backups (default ../backups)
 *
 * A work whose stored title the API disagrees with is **refused**, printed
 * with a `!` and left alone: its apiRef belongs to another work, and filling
 * it in from that work is how 53 documents came to carry someone else's year,
 * playtime and links in the first place. See ../work_metadata_merge.js and
 * `scripts/audit_database.js --verify-shared-refs`, which says which of the
 * pair is the misfiled one. #290.
 *
 * Some fields are **filled and never replaced**, whatever the mode: both
 * titles for every type, because the title is the only evidence a ref is wrong
 * and a refresh that rewrote it would erase the disagreement the refusal
 * reads; and a book's `releaseYear` and `duration`, because an ISBN names an
 * edition and Google Books answers about the printing rather than the work.
 * `fillOnlyFields` in ../work_metadata_merge.js has the measurements.
 *
 * The run exits non-zero if every API call it made failed, so a schedule can
 * tell a crawl that is progressing from one that has quietly stopped.
 */
require("../env");
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
const { mergeWork } = require("../work_metadata_merge");
const {
  DEFAULT_MAX_AGE_DAYS,
  DAY_MS,
  selectForRefresh,
  runsRemaining,
} = require("../metadata_refresh_plan");
const { loadAdapter, describeError } = require("../load_adapter");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  missingOnly: args["missing-only"] === true,
  force: args.force === true,
  maxAgeMs: (parseInt(args["max-age-days"]) || DEFAULT_MAX_AGE_DAYS) * DAY_MS,
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

  reportProgress(report);
};

/**
 * Exits non-zero when a run asked the APIs for something and got nothing back.
 *
 * The one thing a scheduled crawl has to be able to say about itself. A run
 * that fetches a few hundred works and fails on eleven of them is a normal
 * run and stays green — a job that goes red for ordinary weather is a job
 * whose red nobody reads, which is the failure #303 describes from the other
 * end. A run where every call failed is the one that matters: a revoked key,
 * a daily quota already spent, an API that has gone away. It looks identical
 * to a successful run in every count except this one, and it leaves
 * `metadataUpdatedDate` exactly where it was, so the next run re-reads the
 * same slice and fails the same way, silently, for ever.
 *
 * "Progress" is deliberately not "something changed": a work the API confirms
 * is already current, and a work whose ref is refused, both advance the queue
 * and both are a working API. Only an unanswered call is not progress.
 */
const reportProgress = (report) => {
  const totals = Object.values(report).reduce(
    (sum, result) => ({
      processed: sum.processed + (result.processed ?? 0),
      answered:
        sum.answered +
        (result.changes?.length ?? 0) +
        (result.refusals?.length ?? 0) +
        (result.unchanged ?? 0),
      failed: sum.failed + (result.failures?.length ?? 0),
    }),
    { processed: 0, answered: 0, failed: 0 }
  );

  if (totals.processed === 0 || totals.answered > 0) return;

  console.error(
    `\nEvery one of the ${totals.failed} API calls this run made failed, so ` +
      `no work advanced and the next run will re-read the same slice. This ` +
      `is what a spent daily quota, a revoked key or a dead API looks like — ` +
      `read the errors above rather than re-running.`
  );
  process.exitCode = 1;
};

const backfillCollection = async (db, collection) => {
  console.log(`\n=== ${collection.works} ===`);

  const adapter = loadAdapter(collection);
  if (!adapter) return { skipped: "adapter could not be loaded" };

  const works = await db.collection(collection.works).find().toArray();
  const { due, selected } = selectForRefresh(collection, works, options);

  const runs = runsRemaining(due.length, options.limit);
  console.log(
    `  ${works.length} works, ${due.length} due, ` +
      `processing ${selected.length} (longest unchecked first)` +
      (runs !== null && runs > 1
        ? ` — ${runs} runs of this size to catch up`
        : "")
  );

  if (selected.length === 0) {
    return { works: works.length, due: due.length, processed: 0 };
  }

  if (options.apply) backup(collection.works, works);

  const delayMs = options.delayMs ?? collection.defaultDelayMs;
  const changes = [];
  const failures = [];
  const refusals = [];
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

    const { updates, notes, refused } = mergeWork(
      collection,
      work,
      result.value,
      options
    );

    // The apiRef named a different work, so this call said nothing about this
    // document. Reported rather than counted as "already current" — but it is
    // `touch`ed, which is the opposite of what this did before #333.
    //
    // Not touching was right for a run somebody sat and watched: the work is
    // exactly what wants looking at, and leaving it undated kept it at the
    // front of the next run. Under a schedule that reading inverts. A refusal
    // is a stable property of the pair — 53 works carry another work's id and
    // will refuse every time until a human repairs one of them — and
    // longest-unchecked-first sorts every undated work to the head of the
    // queue. So an untouched refusal is re-fetched every single night, ahead
    // of the works that have never been read at all, on a budget of about a
    // thousand Google Books calls a day. A hundred permanent refusals would
    // spend a hundred calls a night for ever and hold up the crawl behind them.
    //
    // Nothing is hidden by the change. The refusal is printed and goes into
    // `--json` on the run that finds it, `scripts/audit_database.js
    // --verify-shared-refs` and `--verify-titles` are what actually diagnose
    // which half is misfiled, and `--missing-only` ignores the date entirely,
    // so a refused work is still picked up by every gap-filling run. #290.
    if (refused) {
      console.log(`  ! ${title(work)}: ${refused}`);
      refusals.push({ ...describe(work), refused });
      if (options.apply) await touch(db, collection, work);
      continue;
    }

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
      `${unchanged} already current, ${refusals.length} refused (the apiRef ` +
      `names another work), ${failures.length} failed, ` +
      `${unrefreshable.length} without a ${collection.retrievePrefix}__ ref`
  );

  return {
    works: works.length,
    due: due.length,
    processed: selected.length,
    changes,
    failures,
    refusals,
    unrefreshable,
    unchanged,
  };
};

/**
 * Marks a work as checked, so an interrupted run resumes cheaply and a sliced
 * one advances. The stamp is what `../metadata_refresh_plan.js` orders the
 * queue by, and it means "last asked about" rather than "last changed" — see
 * `lastCheckedAt` there.
 */
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
