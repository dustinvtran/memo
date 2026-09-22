#!/usr/bin/env node
/**
 * @file Sorts the books `backfill_work_metadata.js` refuses into the four
 * things a refusal can be, and writes them out for a person to approve. #385.
 *
 * `backfill_work_metadata.js --missing-only --only=books` retrieves 270-odd
 * due books and refuses 74. Every one is `mergeWork`'s #290 title guard — the
 * stored title disagrees with the one the ISBN answers with — and none has
 * refreshed since it was stored. #384's `--fail-on-refusal` cannot go into
 * `.github/workflows/refresh_metadata.yml` until they are gone, because the
 * nightly job would be red on its next firing.
 *
 * **This script has no `--apply` and never will.** It is not a dry run with
 * the writing half missing: there is no writing half. An ISBN names an
 * edition, so the 74 are four different problems wanting three different
 * repairs, and every one of those repairs is a decision about text a person
 * can read. `../book_refusal_triage.js` decides which bucket a row is in and
 * writes down the evidence; a human decides whether it is right; the existing
 * repair scripts do the writing, from this file, having re-checked every claim
 * against the API themselves.
 *
 * The rename buckets deliberately leave `entryTitle` blank. `link_entry.js`
 * refuses a `workTitle` without one, and that guard is the reason the script
 * is allowed near `*Entries` at all: the name a work loses has to be written
 * down on the entry, and only the person whose row it is may write it.
 * Pre-filling them would turn a per-row repair into the sweep the rule
 * forbids.
 *
 * ## What it costs, and the answer it will not invent
 *
 * One Google Books call per refused book, for the evidence the adapter's own
 * retrieve does not surface: `volumeInfo.language`, `volumeInfo.subtitle` and
 * the volume's authors. With `--from-report` that is the only spending — the
 * stored title and the title the ISBN answers with are both already in the
 * refusal message a backfill `--json` recorded, so 74 books cost 74 calls
 * against a budget of about a thousand a day.
 *
 * **A book whose lookup did not land is not classified.** Google Books starts
 * answering 429 partway through a crawl and a refused page comes back empty,
 * which is indistinguishable from one that found nothing; #375 made the
 * `q=isbn:` lookup raise `EMPTY_LOOKUP` so `retrying` can see it. Those books
 * are counted per item and reported as "not searched", never bucketed, and
 * `--retry` asks again and merges the answers back into the file. Reporting a
 * finding from a call that never happened is the one failure this whole file
 * is arranged against.
 *
 * **The 54 failures the same backfill reports are not these.** They are quota
 * on the retrieve, not frozen works, and `frozenWorks` in
 * `../metadata_refresh_plan.js` is what keeps the two apart. They are carried
 * into the summary as their own number and never added into a bucket.
 *
 * ## `--limit` does not size a sweep to a budget, and CLAUDE.md is stale here
 *
 * A refusal used to leave a work undated, which sorted it to the head of
 * `selectForRefresh`'s longest-unchecked-first queue — CLAUDE.md's data trap
 * still says so, and says a 96% refusal rate in the first progress line is
 * expected. #333 and #352 inverted that deliberately: a refusal is a stable
 * property of a pair rather than weather, so it is `touch`ed like any other
 * answer, and a refused work now sorts as recently-checked. The 2026-09-21 run
 * measured the consequence — every one of 324 due books carried a
 * `metadataUpdatedDate`, the first 150 produced **no refusals at all**, and
 * all 97 were in the last 174.
 *
 * So `--limit` cuts the head of the queue, which is where the refusals are
 * not. A sweep limited to a budget spends the budget and reports nothing
 * wrong, which reads exactly like a library with nothing wrong with it. Run
 * the sweep whole, or hand it a `--from-report` from a backfill that already
 * ran; `--limit` is for capping the *classification* that follows.
 *
 * Usage:
 *   node scripts/triage_book_refusals.js --from-report=refresh.json
 *   node scripts/triage_book_refusals.js --out=/tmp/triage.json
 *   node scripts/triage_book_refusals.js --retry=triage.json
 *
 * Flags:
 *   --from-report=path  take the refusals from a backfill --json report
 *                       instead of sweeping again
 *   --out=path          where the JSON goes
 *   --markdown=path     where the readable copy goes (default: --out with .md)
 *   --limit=N           stop after N refused books
 *   --retry=path        look up again the books a run could not look up, and
 *                       merge the answers into that file
 *   --delay-ms=N        override the pause between API calls
 *
 * Environment (../.env): MONGODB_URL, and GOOGLE_API_KEY — optional, but the
 * unauthenticated rate limit will not carry a run of this size.
 */
require("../env");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  findApiRef,
  displayTitle,
  sleep,
  parseArgs,
} = require("../work_collections");
const { mergeWork } = require("../work_metadata_merge");
const { selectForRefresh } = require("../metadata_refresh_plan");
const { loadAdapter, describeError } = require("../load_adapter");
const {
  parseRefusal,
  triageRow,
  summarize,
  toMarkdown,
  describeSummary,
} = require("../book_refusal_triage");
const {
  BASE_URL,
} = require("../../api/utils/external_api_adapters/books/google_search.js");
const {
  retrying,
  describeFailure,
} = require("../../api/utils/external_api_adapters/retry.js");

const args = parseArgs(process.argv);

const options = {
  fromReport:
    args["from-report"] === undefined ? undefined : String(args["from-report"]),
  retry: args.retry === undefined ? undefined : String(args.retry),
  limit: parseInt(args.limit) || Infinity,
  delayMs: args["delay-ms"] === undefined ? undefined : parseInt(args["delay-ms"]),
  out: args.out === undefined ? undefined : String(args.out),
  markdown: args.markdown === undefined ? undefined : String(args.markdown),
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

const books = COLLECTIONS.find((collection) => collection.type === "books");

/**
 * Attempts per lookup, above the adapter's three for the reason
 * propose_book_refs.js raises it: a 429 here is a crawl being throttled, and
 * giving up early files a book as unexplained when it was never asked about.
 */
const LOOKUP_ATTEMPTS = 5;

/** Built inside main() so the module can be required without MONGODB_URL. */
let client;

/**
 * Retrieves that did not answer, kept apart from the refusals for the whole
 * length of the run. A failure is quota and a refusal is a frozen work, and
 * `frozenWorks` in ../metadata_refresh_plan.js draws the same line: the
 * backfill reports 54 of the first and 74 of the second, and folding either
 * into the other is the mistake #385 names.
 */
let sweepFailures = 0;
let reportFailures = 0;

const main = async () => {
  if (args.apply) {
    console.error(
      "There is no --apply here, and that is deliberate. This script " +
        "classifies and explains; link_entry.js, set_work_ref.js and " +
        "propose_book_refs.js do the writing, from rows a person approved."
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  if (options.retry) await retryPhase(db);
  else await triagePhase(db);

  await client.close();
};

const triagePhase = async (db) => {
  console.log(
    "TRIAGE: nothing is written to the database, here or by any flag this " +
      "script has. Read the file, check the rows, then hand the approved " +
      "ones to the repair script each names.\n"
  );

  const works = await db.collection(books.works).find().toArray();
  const refused = options.fromReport
    ? fromReport(works)
    : await sweep(works);

  const chosen = refused.slice(0, options.limit);
  console.log(
    `\n${refused.length} book(s) the guard refuses; looking up ` +
      `${chosen.length} ISBN(s) for the language, subtitle and authors the ` +
      `retrieve does not surface.`
  );

  const rows = [];
  const notSearched = [];

  for (const [index, entry] of chosen.entries()) {
    if (index > 0) await sleep(delay());
    const row = await classifyOne(entry);
    if (row.notSearched) notSearched.push(row.record);
    else rows.push(row.record);
    console.log(`  ${mark(row)} ${row.record.storedTitle} — ${label(row)}`);
  }

  write({ rows, notSearched, failures: reportedFailures() });
};

/**
 * Looks up one refused book's ISBN and classifies it, or reports that the
 * question could not be asked.
 *
 * The stored title and the title the ISBN answers with come from the refusal
 * message where there is one, so a `--from-report` run still has both even
 * when Google Books will not answer — which is exactly why an unanswered
 * lookup is reported rather than classified on those two alone. Language and
 * author are what separate a translation from a different book, and a row
 * bucketed without them would be a guess with a citation.
 */
const classifyOne = async ({ work, refusal }) => {
  // The bare number to look the volume up by, and the prefixed ref
  // `set_work_ref.js` will check `replacesRef` against. `ISBN` is books'
  // `retrievePrefix`, and `work_ref_repair.js` builds the ref it compares as
  // `ISBN__<bare>` from exactly this call — so the two agree by construction
  // rather than by a string this file spells for itself. A work with no
  // `ISBN__` ref is never retrieved and so is never among the refusals.
  const isbn = findApiRef(work.apiRefs, books.retrievePrefix);
  const apiRef = isbn === undefined ? undefined : `${books.retrievePrefix}__${isbn}`;
  const parsed = parseRefusal(refusal);
  const volume = isbn ? await lookupVolume(isbn) : { error: "no ISBN on the work" };

  if (volume.error) {
    return {
      notSearched: true,
      record: {
        id: String(work._id),
        storedTitle: displayTitle(work),
        // Kept even though nothing was concluded from them: a person reading
        // the not-searched list still wants to see what the pair looked like.
        refTitle: parsed?.refTitle ?? null,
        isbn: isbn ?? null,
        refusal,
        notSearchedBecause: volume.error,
      },
    };
  }

  const record = triageRow({
    work,
    refTitle: volume.info?.title ?? parsed?.refTitle,
    refSubtitle: volume.info?.subtitle,
    refAuthors: volume.info?.authors,
    refLanguage: volume.info?.language,
    isbn,
    apiRef,
  });

  return { notSearched: false, record: { ...record, refusal } };
};

/**
 * One volume's raw `volumeInfo`, which is not the same thing as the adapter's
 * retrieve.
 *
 * `google.js` maps `englishTranslatedTitle: volumeInfo.title` and surfaces
 * neither `subtitle` nor `language`, and both are evidence this needs: the
 * subtitle is what tells a genuine misfiling from the adapter disagreeing with
 * itself, and the language is what tells a translation from a different book.
 * So the endpoint is read directly here rather than through `loadAdapter`.
 *
 * An empty `200` is thrown as `EMPTY_LOOKUP` the way the adapter throws it, so
 * `retrying` treats it as worth another attempt — #375 measured that roughly
 * half of one backfill's misses were that, and every one of 35 chased
 * afterwards resolved.
 */
const lookupVolume = async (isbn) => {
  const url = `${BASE_URL}?q=isbn:${encodeURIComponent(isbn)}${urlKey()}`;
  try {
    let waited = 0;
    const { data } = await retrying(
      () =>
        axios({ method: "get", url }).then((response) => {
          const items = response.data?.items ?? [];
          if (items.length === 0) {
            throw Object.assign(
              new Error(`Google Books answered nothing for ISBN ${isbn}.`),
              { code: "EMPTY_LOOKUP" }
            );
          }
          return response;
        }),
      {
        attempts: LOOKUP_ATTEMPTS,
        // As propose_book_refs.js does it: `retrying`'s own backoff tops out
        // at two seconds, which is far too short for a per-minute limit that
        // has to be waited out rather than sprinted at.
        sleep: () => sleep(delay() * 2 ** waited++),
      }
    );
    return { info: data.items[0]?.volumeInfo ?? {} };
  } catch (e) {
    return { error: describeFailure(e) };
  }
};

/**
 * Asks the guard which books it refuses, rather than re-implementing it.
 *
 * The same selection `backfill_work_metadata.js --missing-only` makes, the
 * same retrieve and the same `mergeWork`, for the reason propose_book_refs.js
 * gives: a pasted list of ids is stale the first time a title is corrected,
 * and a second copy of the title comparison is a second thing to keep in step
 * with #327.
 *
 * A retrieve that fails here is a failure and not a refusal, and is counted as
 * one — this is the 54, and the line `frozenWorks` draws.
 */
const sweep = async (works) => {
  const adapter = loadAdapter(books);
  if (!adapter) {
    process.exitCode = 1;
    return [];
  }

  const { selected } = selectForRefresh(books, works, { missingOnly: true });
  const targets = selected.filter((work) => findApiRef(work.apiRefs, "ISBN"));

  console.log(
    `${works.length} books, ${targets.length} that a --missing-only backfill ` +
      `would fetch. Asking Google Books which it refuses (up to ` +
      `${targets.length} calls). --from-report=<backfill --json> skips this.`
  );

  const refused = [];
  sweepFailures = 0;

  for (const [index, work] of targets.entries()) {
    if (index > 0) await sleep(delay());

    const result = await adapter.retrieve(findApiRef(work.apiRefs, "ISBN"));
    if (result.isErr()) {
      sweepFailures += 1;
      console.log(`  ! ${displayTitle(work)}: ${describeError(result.error)}`);
      continue;
    }

    const { refused: refusal } = mergeWork(books, work, result.value, {
      missingOnly: true,
    });
    if (refusal) refused.push({ work, refusal });

    if ((index + 1) % 50 === 0) {
      console.log(
        `  ...${index + 1}/${targets.length} asked, ${refused.length} refused, ` +
          `${sweepFailures} failed`
      );
    }
  }

  return refused;
};

/**
 * The refusals a backfill already found, read out of its `--json`.
 *
 * The flag to reach for whenever a backfill has been run today: the sweep
 * costs one call per book with a gap and this costs none, and the refusal
 * message carries both titles already.
 */
const fromReport = (works) => {
  const report = JSON.parse(fs.readFileSync(options.fromReport, "utf8"));
  const refusals = report?.books?.refusals ?? [];
  const byId = new Map(works.map((work) => [String(work._id), work]));

  reportFailures = (report?.books?.failures ?? []).length;

  console.log(
    `${refusals.length} refusal(s) and ${reportFailures} failure(s) in ` +
      `${options.fromReport}; no sweep this run. The failures are quota on ` +
      `the retrieve, not frozen works, and are not classified.`
  );

  return refusals
    .map((refusal) => ({
      work: byId.get(String(refusal.id)),
      refusal: refusal.refused,
    }))
    .filter(({ work }) => work !== undefined);
};

const reportedFailures = () =>
  options.fromReport ? reportFailures : sweepFailures;

/**
 * Looks up again the books a previous run could not look up, and merges the
 * answers into that run's file.
 *
 * Only those: the refusals are already in the file and the guard does not need
 * running twice to find the same 74. Rows a person has already approved are
 * left exactly as they are — somebody may have worked through half of the file
 * before noticing the gaps.
 */
const retryPhase = async (db) => {
  const previous = JSON.parse(fs.readFileSync(options.retry, "utf8"));
  const stale = previous.notSearched ?? [];

  console.log(
    `RETRY: ${(previous.rows ?? []).length} classified row(s) in ` +
      `${options.retry}, ${stale.length} book(s) never looked up.`
  );

  if (stale.length === 0) {
    // Still rewritten, so a retry on a file with nothing left to ask
    // regenerates the Markdown from the JSON rather than doing nothing
    // quietly — the only way to get the two back in step after a hand edit.
    write({
      rows: previous.rows ?? [],
      notSearched: [],
      failures: previous.summary?.failures ?? 0,
    });
    return;
  }

  const works = await db.collection(books.works).find().toArray();
  const byId = new Map(works.map((work) => [String(work._id), work]));

  const rows = [...(previous.rows ?? [])];
  const stillNot = [];

  for (const [index, record] of stale.slice(0, options.limit).entries()) {
    const work = byId.get(String(record.id));
    if (!work) {
      console.log(`  ! ${record.storedTitle}: gone from ${books.works}`);
      continue;
    }
    if (index > 0) await sleep(delay());

    const row = await classifyOne({ work, refusal: record.refusal });
    if (row.notSearched) stillNot.push(row.record);
    else rows.push(row.record);
    console.log(`  ${mark(row)} ${row.record.storedTitle} — ${label(row)}`);
  }

  write({
    rows,
    notSearched: [...stillNot, ...stale.slice(options.limit)],
    failures: previous.summary?.failures ?? 0,
  });
};

///////////////////////////////////////////////////////////////////////////////
// Output

const write = ({ rows, notSearched, failures }) => {
  const summary = summarize(rows, { notSearched: notSearched.length, failures });
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const jsonPath =
    options.out ??
    options.retry ??
    path.join(options.backupDir, `book_refusal_triage_${stamp}.json`);
  const markdownPath =
    options.markdown ?? jsonPath.replace(/\.json$/, "") + ".md";

  const file = { generatedAt: new Date().toISOString(), summary, rows, notSearched };

  fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(file, null, 2));
  fs.writeFileSync(markdownPath, toMarkdown(file, path.basename(jsonPath)));

  console.log(`\n${describeSummary(summary)}`);
  console.log(`\nTriage written to ${jsonPath}`);
  console.log(`Readable copy at  ${markdownPath}`);
};

const mark = (row) => (row.notSearched ? "?" : "·");

const label = (row) =>
  row.notSearched
    ? `not searched: ${row.record.notSearchedBecause}`
    : `${row.record.bucket}`;

const delay = () => options.delayMs ?? books.defaultDelayMs;

/** The key goes on every request when there is one, as the adapter does it. */
const urlKey = () =>
  process.env.GOOGLE_API_KEY ? `&key=${process.env.GOOGLE_API_KEY}` : "";

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
