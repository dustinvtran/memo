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
 *   --limit=N           stop after N works per collection (default: the
 *                       collection's own `defaultLimit`, since the four APIs
 *                       and the four queues are not alike — #352)
 *   --delay-ms=N        override the per-type pause between API calls
 *   --fail-on-refusal   exit non-zero if any work could not be refreshed
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
 * **Every outcome but an unanswered call advances the queue.** A work that was
 * updated, one the API confirmed was current, one whose ref is refused, one
 * whose ref the API no longer holds and one carrying no ref at all are all
 * stamped with `metadataUpdatedDate`, so the next run takes the works behind
 * them rather than the same ones again. Only a failure that might succeed
 * tomorrow — a 429, a 503, a timeout — is left unstamped, and the comments at
 * each of those branches say why that one falls where it does. #333 made the
 * refusal stamp and #352 the other two, after a nightly slice of 150 books
 * went entirely to works that could not be updated.
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
  isPermanentFailure,
  summarizeProgress,
  frozenWorks,
} = require("../metadata_refresh_plan");
const { loadAdapter, describeError } = require("../load_adapter");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  missingOnly: args["missing-only"] === true,
  force: args.force === true,
  maxAgeMs: (parseInt(args["max-age-days"]) || DEFAULT_MAX_AGE_DAYS) * DAY_MS,
  // Unset rather than unlimited: each collection has its own, and this only
  // overrides it. See `defaultLimit` in ../work_collections.js.
  limit:
    args.limit === undefined ? undefined : parseInt(args.limit) || Infinity,
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
 * is already current, a work whose ref is refused, and a work whose ref the
 * API says it no longer holds all advance the queue and all are a working
 * API. Only an unanswered call is not progress.
 *
 * What #352 changed here is what counts as a call. A work with no ref is not
 * one — the loop below skips it before the request — so it can neither answer
 * nor fail, and a slice made of nothing else used to trip this: `processed`
 * counted those works, `answered` could not, and the run announced that every
 * one of its 0 API calls had failed. `summarizeProgress` in
 * ../metadata_refresh_plan.js counts calls rather than works, and is where
 * that arithmetic is tested.
 */
const reportProgress = (report) => {
  reportFrozen(report);

  const { failed, stalled } = summarizeProgress(report);
  if (!stalled) return;

  console.error(
    `\nEvery one of the ${failed} API calls this run made failed, so ` +
      `no work advanced and the next run will re-read the same slice. This ` +
      `is what a spent daily quota, a revoked key or a dead API looks like — ` +
      `read the errors above rather than re-running.`
  );
  process.exitCode = 1;
};

/**
 * The works this run could not refresh, and whether that should fail it.
 *
 * A refusal has always been printed and has never been anything else: the run
 * exits 0, so a work whose stored title disagrees with its id can be refused
 * every night for years with nothing to notice it. That is exactly how #381's
 * 93 accumulated, and `docs/works_and_entries.md` is what they had in common —
 * a person's name on a work rather than on their entry.
 *
 * Off by default, because a refusal is a fact about the data rather than a
 * fault in the run, and this script is also how somebody looks at a slice.
 * On, it turns a silence into a red build, which is the only thing that would
 * have caught the 93 before they became 93.
 * @type {(report: object) => void}
 */
const reportFrozen = (report) => {
  const frozen = frozenWorks(report);
  if (frozen.length === 0 || args["fail-on-refusal"] !== true) return;

  console.error(
    `
${frozen.length} work(s) could not be refreshed, and this run was ` +
      `asked to fail on that. Each one's stored title disagrees with the ` +
      `title its id answers with, so the #290 guard refused the merge and ` +
      `the work's metadata is frozen until somebody looks. See ` +
      `docs/works_and_entries.md; the repair is link_entry.js's workTitle ` +
      `when the id is right, and set_work_ref.js's replacesRef when it is not.`
  );
  process.exitCode = 1;
};

const backfillCollection = async (db, collection) => {
  console.log(`\n=== ${collection.works} ===`);

  const adapter = loadAdapter(collection);
  if (!adapter) return { skipped: "adapter could not be loaded" };

  const works = await db.collection(collection.works).find().toArray();
  // The same shape as `delayMs` below and for the same reason: the flag when a
  // run was given one, the collection's own number otherwise. Resolved here
  // rather than inside `selectForRefresh`, which is also asked for an unlimited
  // queue by scripts/propose_book_refs.js and must go on answering with one.
  const limit = options.limit ?? collection.defaultLimit ?? Infinity;
  const { due, selected } = selectForRefresh(collection, works, {
    ...options,
    limit,
  });

  const runs = runsRemaining(due.length, limit);
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
  const deadRefs = [];
  const refusals = [];
  const unrefreshable = [];
  let unchanged = 0;
  let asked = 0;

  for (const work of selected) {
    const apiRef = findApiRef(work.apiRefs, collection.retrievePrefix);

    // Nothing to ask. 191 works carry no id the adapter would take (#343),
    // and the `continue` comes before the request, so they cost no call. What
    // they cost is a slot, and until #352 they cost one every night for ever:
    // no call meant nothing to stamp the work with, `metadataUpdatedDate`
    // stayed absent, and longest-unchecked-first sorts an undated work to the
    // head of the queue. On the first autonomous run that was 57 of the 150
    // books in the slice, 38% of the nightly budget, permanently.
    //
    // So it is stamped, on the reasoning of the refusal below rather than a
    // new one. The work has been asked about and the answer is that there is
    // nothing to ask; that answer changes only when a human supplies an id,
    // which is not something that happens overnight. Coming round again in
    // `--max-age-days` is the right cadence for re-checking whether anybody
    // has.
    //
    // Nothing is hidden by the stamp. The work is counted on the line below
    // and named in `--json` on the run that finds it,
    // `scripts/audit_database.js` lists every work with no retrievable ref and
    // does not look at the date to do it, and `--missing-only` ignores the
    // date entirely — so the mode that would notice an id appearing still sees
    // the work every run.
    if (!apiRef) {
      unrefreshable.push(describe(work));
      if (options.apply) await touch(db, collection, work);
      continue;
    }

    // Calls rather than works, since the pause is rate limiting between
    // requests and the works above made none.
    if (asked > 0) await sleep(delayMs);
    asked += 1;

    const result = await adapter.retrieve(apiRef);
    if (result.isErr()) {
      const error = describeError(result.error);
      console.log(`  ! ${title(work)} (${apiRef}): ${error}`);

      // "Try again tomorrow" and "this id is gone" come down the same branch
      // and are not the same outcome. `isPermanentFailure` in
      // ../metadata_refresh_plan.js reads the adapter's error class and has
      // the argument; the short of it is that a 404 is an answer about this
      // work and stamps exactly as a refusal does, while a 429, a 503 or a
      // timeout is weather and must not, because a run that stamped a slice
      // it never read would record a spent quota as six months of freshness.
      //
      // Fourteen works are in the first bucket — `Raiders of the Lost Ark`
      // under `tmdb__62128`, `Ulysses` under `ISBN__9788180320996` — and each
      // was spending a real call every night to be told the same thing, ahead
      // of works that had never been read at all. #352.
      if (isPermanentFailure(result.error)) {
        deadRefs.push({ ...describe(work), error });
        if (options.apply) await touch(db, collection, work);
        continue;
      }

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
    //
    // Two more outcomes joined it in #352 on this same argument and not a new
    // one — a work with no id at all, at the top of the loop, and a ref the
    // API says it no longer holds, just above. The three together are every
    // outcome that is a fact about the work rather than about the weather,
    // and every one of them had been holding its place at the head of a queue
    // it could never leave.
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
      `names another work), ${deadRefs.length} whose ref the API no longer ` +
      `holds, ${failures.length} failed, ` +
      `${unrefreshable.length} without a ${collection.retrievePrefix}__ ref`
  );

  // Counted on its own line because this one is a watch rather than a result:
  // the authors were written, and the number is what says whether the guard
  // behind it is ready to refuse instead of report. #439.
  const strangers = changes.filter((change) =>
    change.notes.some((note) => note.startsWith("authors replaced with no name"))
  );
  if (strangers.length > 0) {
    console.log(
      `  ${strangers.length} had authors replaced with no name in common — ` +
        `a shared title may be two different books`
    );
  }

  return {
    authorMismatches: strangers.length,
    works: works.length,
    due: due.length,
    processed: selected.length,
    asked,
    changes,
    failures,
    deadRefs,
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
