#!/usr/bin/env node
/**
 * @file Proposes English editions for the books filed under a translated
 * edition's ISBN, and repoints the ones a person approves. #344.
 *
 * 147 books are refused by `backfill_work_metadata.js` because the ISBN they
 * are filed under names a different title, and for most of them it is the
 * right book in the wrong language — `The Little Prince` under `Le Petit
 * Prince`, `Animal Farm` under `La ferme des animaux`. The owner does not have
 * the French editions, so the stored `englishTranslatedTitle` is right and the
 * ref is wrong, and these books can never gain a publisher, a cover, a genre
 * or a page count until it changes.
 *
 * **Two phases, and only the second writes.**
 *
 *   - `propose` (the default) asks Google Books for English editions of each
 *     refused book's stored title, filters the answers hard, and writes what
 *     survives to a JSON file and a Markdown one. It has no `--apply` to give
 *     and touches nothing.
 *   - `--apply --from=<file>` reads that JSON back and writes the refs a
 *     person marked approved, and only those.
 *
 * ## Why it does not pick for you
 *
 * Google Books' first hit is wrong often enough that taking it would be #290
 * arriving by a new route: `Animal Farm`'s leading results are a
 * publisher-less 56-page edition, a Chinese-published one and one of a single
 * page, and `Brave New World`'s second is the omnibus `Brave New World and
 * Brave New World Revisited`, which is a different book. These books are in
 * this state because somebody once took a search result without reading it,
 * and a script that does the same thing faster is not an improvement.
 *
 * So the filters in ../book_ref_proposal.js are hard — an English language, an
 * ISBN-13, a publisher, a plausible page count, a title that clears
 * `titlesAgree`, an author that does not contradict the stored one, and an
 * ISBN no other book is filed under — and a book with no survivor is listed as
 * having none rather than given the best of a bad set.
 *
 * **A book whose search could not be run is a third answer, not the second
 * one.** Google Books answers a sustained crawl with 429s — the 2026-09-14 run
 * collected 95 of them across 294 search pages — and a refused search comes
 * back empty, which is indistinguishable from a search that found nothing
 * unless somebody keeps count. So the count is kept, per book, and reported as
 * "not searched"; `--retry` searches those again and merges the answers back
 * into the file. ../load_adapter.js draws the same line for every other API
 * call in this folder: "the API would not answer" and "the API says no" are
 * different answers and only the second is a finding.
 *
 * ## Which books it is about
 *
 * **Asked of the backfill's own guard rather than re-implemented or pasted
 * in.** The run makes the same selection `backfill_work_metadata.js` makes
 * with `--missing-only` (`selectForRefresh`), retrieves the same way, and
 * calls the same `mergeWork`; the population is the works it answers `refused`
 * for. A list of ids would be stale the first time a title was corrected, and
 * a second copy of the title comparison would be a second thing to keep in
 * step with #327.
 *
 * `--from-report=<backfill --json>` reuses the refusals a backfill run already
 * found instead of sweeping again, which is the flag to reach for when one has
 * been run today: the sweep costs one Google Books call per book with a gap
 * (328 of the 650 today) against a daily budget of about a thousand, and the
 * searches cost two more per refused book.
 *
 * ## What a repoint writes
 *
 * `apiRefs` is **narrowed**, the way `repair_shared_refs.js` narrows it: every
 * ref naming the old ISBN comes off under either prefix that names a book, the
 * new one goes on, and any other ref the document carries stays. Then the
 * values that belong to the edition rather than to the work come off —
 * `EDITION_FIELDS` in ../book_ref_proposal.js is the list and the argument for
 * each, and `releaseYear` is deliberately not on it.
 *
 * Every approved ISBN is **verified against Google Books again, immediately
 * before the write**, and against the collection as it stands. A proposal file
 * is a saved answer and may be days old; `repair_shared_refs.js` re-runs its
 * checks at the moment it writes for exactly this reason. An approval that no
 * longer verifies, or that would file two books under one ISBN, is skipped and
 * reported.
 *
 * It writes only to the **books** collection, so no `bookEntries` document and
 * no `entry.overrides` is reachable from it.
 *
 * Take a snapshot with backup_database.js first and verify it with
 * verify_backup.js --live, as every `--apply` in this folder wants.
 *
 * Environment (../.env): MONGODB_URL, and GOOGLE_API_KEY — optional, but the
 * unauthenticated Google Books rate limit will not carry a run of this size.
 *
 * Usage:
 *   node scripts/propose_book_refs.js
 *   node scripts/propose_book_refs.js --limit=20 --out=/tmp/books.json
 *   node scripts/propose_book_refs.js --from-report=refresh.json
 *   node scripts/propose_book_refs.js --retry=proposals.json
 *   node scripts/propose_book_refs.js --apply --from=/tmp/books.json
 *
 * Flags:
 *   --out=path           where the JSON proposals go
 *   --markdown=path      where the readable copy goes (default: --out with .md)
 *   --limit=N            stop after N refused books
 *   --candidates=N       editions to offer per book (default 3)
 *   --search-pages=N     pages of each of the two queries (default 1)
 *   --from-report=path   take the refusals from a backfill --json report
 *   --retry=path         search again for the books a run could not search,
 *                        and merge the answers into that file
 *   --delay-ms=N         override the pause between API calls
 *   --apply --from=path  write the approved refs in a proposal file
 *   --backup-dir=path    where the pre-write backup goes (default ../backups)
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
  EDITION_FIELDS,
  proposeForWork,
  betterAttempt,
  refOwners,
  planRepoint,
} = require("../book_ref_proposal");
const {
  BASE_URL,
  PAGE_SIZE,
  queriesFor,
} = require("../../api/utils/external_api_adapters/books/google_search.js");
const {
  retrying,
  describeFailure,
} = require("../../api/utils/external_api_adapters/retry.js");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  from: args.from === undefined ? undefined : String(args.from),
  fromReport:
    args["from-report"] === undefined ? undefined : String(args["from-report"]),
  retry: args.retry === undefined ? undefined : String(args.retry),
  limit: parseInt(args.limit) || Infinity,
  candidates: parseInt(args.candidates) || 3,
  searchPages: parseInt(args["search-pages"]) || 1,
  delayMs: args["delay-ms"] === undefined ? undefined : parseInt(args["delay-ms"]),
  out: args.out === undefined ? undefined : String(args.out),
  markdown: args.markdown === undefined ? undefined : String(args.markdown),
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

const books = COLLECTIONS.find((collection) => collection.type === "books");

/**
 * Attempts per search page. More than the adapter's three because a 429 here
 * is a crawl being throttled rather than one user unlucky with a 503, and the
 * cost of giving up is a book reported as having no English edition when it
 * was never actually searched.
 */
const SEARCH_ATTEMPTS = 5;

/** Built inside main() so the module can be required without MONGODB_URL. */
let client;

const main = async () => {
  if (options.apply && !options.from) {
    console.error(
      "--apply needs --from=<proposal file>. There is nothing to approve " +
        "without one, and this script never picks a candidate itself."
    );
    process.exitCode = 1;
    return;
  }

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  if (options.apply || options.from) await applyPhase(db);
  else if (options.retry) await retryPhase(db);
  else await proposePhase(db);

  await client.close();
};

///////////////////////////////////////////////////////////////////////////////
// Propose

const proposePhase = async (db) => {
  console.log(
    "PROPOSE: nothing is written, here or to the database. Read the file, " +
      "set `approved` on the books you have checked, then re-run with " +
      "--apply --from=<file>."
  );

  const adapter = loadAdapter(books);
  if (!adapter) {
    process.exitCode = 1;
    return;
  }

  const works = await db.collection(books.works).find().toArray();
  const owners = refOwners(books, works);

  const refused = options.fromReport
    ? fromReport(works)
    : await sweep(adapter, works);

  const chosen = refused.slice(0, options.limit);
  console.log(
    `\n${refused.length} book(s) the guard refuses; proposing for ` +
      `${chosen.length}, at ${2 * options.searchPages} search call(s) each.`
  );

  const proposals = [];
  for (const [index, { work, fresh, refusal }] of chosen.entries()) {
    if (index > 0) await sleep(delay());

    const search = await searchEnglishEditions(displayTitle(work));
    const proposal = {
      ...proposeForWork(work, fresh, search.volumeInfos, {
        owners,
        limit: options.candidates,
      }),
      refusal,
      searchFailures: search.failures,
      searchPages: search.pages,
    };
    proposals.push(proposal);

    console.log(`  ${mark(proposal)} ${proposal.title}: ${describeProposal(proposal)}`);
  }

  writeProposals(proposals);
  summarize(proposals);
};

/**
 * Searches again for the books a previous run could not search, and merges the
 * answers into that run's file.
 *
 * This exists because the rate limit is real and a propose run is long: the
 * production run on 2026-09-14 spent its budget partway through and came back
 * with 35 refused search pages, whose books would otherwise have been filed
 * as "no English edition" on the strength of a question nobody got to ask.
 *
 * It re-searches only those books, so it costs two calls each rather than
 * another sweep — the refusals are already in the file and the guard does not
 * need running twice to find the same 144. Approvals already written into the
 * file are preserved: somebody may have worked through half of it before
 * noticing the gaps.
 */
const retryPhase = async (db) => {
  const previous = JSON.parse(fs.readFileSync(options.retry, "utf8"));
  const stale = previous.filter(
    (proposal) => (proposal.searchFailures ?? 0) > 0 && !proposal.approved
  );

  console.log(
    `RETRY: ${previous.length} proposal(s) in ${options.retry}, ` +
      `${stale.length} of them not properly searched.`
  );

  // Still rewritten, so that a `--retry` on a file with nothing left to search
  // regenerates the readable copy from the JSON rather than doing nothing
  // quietly. It is the only way to get the Markdown back in step after
  // somebody has edited the file by hand.
  if (stale.length === 0) {
    writeProposals(previous);
    summarize(previous);
    return;
  }

  const works = await db.collection(books.works).find().toArray();
  const byId = new Map(works.map((work) => [String(work._id), work]));
  const owners = refOwners(books, works);

  const chosen = stale.slice(0, options.limit);
  const redone = new Map();

  for (const [index, proposal] of chosen.entries()) {
    const work = byId.get(String(proposal.id));
    if (!work) {
      console.log(`  ! ${proposal.title}: gone from ${books.works}`);
      continue;
    }

    if (index > 0) await sleep(delay());

    const search = await searchEnglishEditions(displayTitle(work));
    const fresh = await proposeForWork(work, undefined, search.volumeInfos, {
      owners,
      limit: options.candidates,
    });

    // The retrieve that produced these is not re-run — it is a call per book
    // for something the first run already asked and wrote down.
    const merged = {
      ...fresh,
      currentRefNames: proposal.currentRefNames,
      refusal: proposal.refusal,
      approved: proposal.approved ?? null,
      searchFailures: search.failures,
      searchPages: search.pages,
    };

    // A retry that was throttled too must not cost the book the candidates the
    // first run did find. The rule is the same one the whole script runs on:
    // an unanswered question replaces nothing. Fewer failed pages wins, and a
    // tie goes to whichever saw more editions.
    const kept = betterAttempt(proposal, merged);

    redone.set(String(proposal.id), kept);
    console.log(
      `  ${mark(kept)} ${kept.title}: ${describeProposal(kept)}` +
        (kept === proposal ? " (kept the earlier answer)" : "")
    );
  }

  const proposals = previous.map(
    (proposal) => redone.get(String(proposal.id)) ?? proposal
  );

  writeProposals(proposals);
  summarize(proposals);
};

/**
 * The books the backfill refuses, found by running what the backfill runs: its
 * own selection, its own adapter, its own merge. Nothing here decides whether
 * a title matches.
 *
 * `--limit` stops the sweep as well as the proposing, so that a run sized to a
 * budget spends its calls on the books it will actually propose for rather
 * than on finding every book it then discards. The order is
 * `selectForRefresh`'s — longest unchecked first — so successive limited runs
 * work through the collection instead of re-reading its head.
 */
const sweep = async (adapter, works) => {
  const { selected } = selectForRefresh(books, works, { missingOnly: true });
  const targets = selected.filter((work) => findApiRef(work.apiRefs, "ISBN"));

  console.log(
    `\n${works.length} books, ${targets.length} that a --missing-only ` +
      `backfill would fetch. Asking Google Books which of them it refuses ` +
      `(up to ${targets.length} calls).`
  );

  const refused = [];
  for (const [index, work] of targets.entries()) {
    if (refused.length >= options.limit) break;
    if (index > 0) await sleep(delay());

    const result = await adapter.retrieve(findApiRef(work.apiRefs, "ISBN"));
    if (result.isErr()) {
      console.log(`  ! ${displayTitle(work)}: ${describeError(result.error)}`);
      continue;
    }

    const { refused: refusal } = mergeWork(books, work, result.value, {
      missingOnly: true,
    });
    if (refusal) refused.push({ work, fresh: result.value, refusal });

    if ((index + 1) % 50 === 0) {
      console.log(
        `  ...${index + 1}/${targets.length} asked, ${refused.length} refused`
      );
    }
  }

  return refused;
};

/**
 * The same refusals, read out of a `backfill_work_metadata.js --json` report
 * rather than found again. The report carries the ids and the guard's own
 * sentence; what it does not carry is the adapter's response, so a proposal
 * built this way names the wrong ISBN without saying what it names — the
 * refusal sentence has both titles in it either way.
 */
const fromReport = (works) => {
  const report = JSON.parse(fs.readFileSync(options.fromReport, "utf8"));
  const refusals = report?.books?.refusals ?? [];
  const byId = new Map(works.map((work) => [String(work._id), work]));

  console.log(
    `\n${refusals.length} refusal(s) in ${options.fromReport}; no sweep this run.`
  );

  return refusals
    .map((refusal) => ({
      work: byId.get(String(refusal.id)),
      fresh: undefined,
      refusal: refusal.refused,
    }))
    .filter(({ work }) => work !== undefined);
};

/**
 * Every English volume Google Books offers for a title.
 *
 * The two queries are `queriesFor`'s, so the `intitle:"…"` trick #138 measured
 * is not re-derived here — a bare keyword ranks a 2019 novel behind every
 * monograph with the word in its index. `langRestrict=en` is the addition, and
 * `volumeInfo.language` is checked again on the way in: the parameter is a
 * preference and the field is the answer.
 *
 * One page of each by default rather than `searchUrls`' two, because the
 * filters downstream are strict enough that a second page adds candidates far
 * more slowly than it adds calls, and the budget is about a thousand a day.
 * `--search-pages` raises it for a book that came back empty.
 *
 * A page Google will not answer comes back empty rather than failing the book,
 * which is `searchPages`' behaviour in the adapter and for its reason: it
 * answers something like one search in eight with a 503, and fewer results is
 * a better answer than none.
 */
const searchEnglishEditions = async (title) => {
  const urls = queriesFor(title).flatMap((query) =>
    Array.from(
      { length: options.searchPages },
      (_, page) =>
        `${BASE_URL}?q=${encodeURIComponent(query)}` +
        `&printType=books&langRestrict=en&maxResults=${PAGE_SIZE}` +
        `&startIndex=${page * PAGE_SIZE}${urlKey()}`
    )
  );

  const pages = [];
  let failures = 0;

  for (const [index, url] of urls.entries()) {
    if (index > 0) await sleep(delay());
    try {
      let waited = 0;
      const { data } = await retrying(() => axios({ method: "get", url }), {
        attempts: SEARCH_ATTEMPTS,
        // `retrying`'s own backoff tops out at two seconds, which is right for
        // one user waiting on one search and far too short for a crawl that
        // has just been told 429 — a per-minute limit needs to be waited out,
        // not sprinted at. Starts at the pause between calls and doubles.
        sleep: () => sleep(delay() * 2 ** waited++),
      });
      pages.push((data?.items ?? []).map((item) => item?.volumeInfo));
    } catch (e) {
      console.log(`      search page failed: ${describeFailure(e)}`);
      failures += 1;
    }
  }

  return {
    volumeInfos: pages.flat().filter((volumeInfo) => volumeInfo),
    failures,
    pages: urls.length,
  };
};


const writeProposals = (proposals) => {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const jsonPath =
    options.out ??
    options.retry ??
    path.join(options.backupDir, `book_refs_${stamp}.json`);
  const markdownPath =
    options.markdown ?? jsonPath.replace(/\.json$/, "") + ".md";

  fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(proposals.map(trimmed), null, 2));
  fs.writeFileSync(markdownPath, toMarkdown(proposals, jsonPath));

  console.log(`\nProposals written to ${jsonPath}`);
  console.log(`Readable copy at    ${markdownPath}`);
};

/**
 * How many of a book's rejected volumes are kept in the file.
 *
 * All of them is 40-odd per book and a 1.6 MB JSON for one run, which is a lot
 * of weight for a file whose job is to be read and annotated. The Markdown
 * shows three, they are sorted nearest-miss first, and `considered` keeps the
 * true count of what was looked at — so nothing that is actually reported is
 * lost, and neither is the denominator.
 */
const REJECTIONS_KEPT = 5;

const trimmed = (proposal) => ({
  ...proposal,
  rejected: (proposal.rejected ?? []).slice(0, REJECTIONS_KEPT),
});

/**
 * The readable half. The numbers a person needs in order to reject a candidate
 * are the ones that told the sample apart — the publisher, the year, the page
 * count — so every one of them is in the table rather than behind a link.
 */
const toMarkdown = (proposals, jsonPath) => {
  const offered = proposals.filter((p) => p.candidates.length > 0);
  const unsearched = proposals.filter(
    (p) => p.candidates.length === 0 && p.searchFailures > 0
  );
  const none = proposals.length - offered.length - unsearched.length;

  const lines = [
    "# English editions proposed for the books filed under another book's ISBN",
    "",
    `#344. ${proposals.length} book(s) the metadata backfill refuses because ` +
      `the ISBN they are filed under names a different title — usually the ` +
      `same book in another language. ${offered.length} have at least one ` +
      `English edition that clears every filter; ${none} have none; ` +
      `${unsearched.length} could not be searched.`,
    "",
    ...(unsearched.length > 0
      ? [
          `> **${unsearched.length} of these were never actually searched.** ` +
            `Google Books rate-limited the run, and a refused search comes ` +
            `back looking exactly like one that found nothing. They are ` +
            `marked "Not searched" below rather than counted as books with no ` +
            `English edition — do not read the absence of a candidate there ` +
            `as an answer. \`--retry\` finishes them once the quota resets.`,
          "",
        ]
      : []),
    "**Nothing here has been written.** To approve one, set `approved` to the " +
      `ISBN you have checked in \`${path.basename(jsonPath)}\`, leave the ` +
      "rest `null`, and run `node scripts/propose_book_refs.js --apply " +
      "--from=<that file>`. A repoint also clears " +
      `\`${Object.keys(EDITION_FIELDS).join("`, `")}\` so the next backfill ` +
      "refills them from the new edition; the stored `releaseYear`, " +
      "`authors`, `genres` and `publishers` are left alone.",
    "",
  ];

  for (const [index, proposal] of proposals.entries()) {
    lines.push(`### ${index + 1}. ${proposal.title}`);
    lines.push("");
    lines.push(
      `${proposal.authors.join(", ") || "author unknown"} · stored year ` +
        `${proposal.storedYear ?? "—"} · stored pages ` +
        `${proposal.storedPageCount ?? "—"} · \`_id\` \`${proposal.id}\``
    );
    lines.push("");
    lines.push(
      `Filed under \`${proposal.currentRef}\`, which Google Books calls ` +
        `**${proposal.currentRefNames ?? refusedTitleOf(proposal) ?? "?"}**.`
    );
    lines.push("");

    if (proposal.candidates.length === 0) {
      if (proposal.searchFailures > 0) {
        lines.push(
          `**Not searched.** ${proposal.searchFailures} of ` +
            `${proposal.searchPages} search page(s) failed, so this book has ` +
            "no answer either way — re-run with `--retry` before reading " +
            "anything into it."
        );
        lines.push("");
        continue;
      }
      if (proposal.rejected.length === 0) {
        lines.push("**Google Books answered the search with nothing at all.**");
        lines.push("");
        continue;
      }

      lines.push(
        `**No candidate survived** ${proposal.considered} volume(s): ` +
          `${countsByLabel(proposal.rejected)}. The ones that got furthest:`
      );
      lines.push("");
      lines.push("| ISBN-13 | title | publisher | pages | refused because |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const miss of proposal.rejected.slice(0, 3)) {
        lines.push(
          `| ${miss.isbn ? `\`${miss.isbn}\`` : "—"} | ${cell(miss.fullTitle)} | ` +
            `${cell(miss.publisher)} | ${miss.pageCount ?? "—"} | ${cell(miss.reason)} |`
        );
      }
      lines.push("");
      continue;
    }

    if (proposal.searchFailures > 0) {
      lines.push(
        `_${proposal.searchFailures} of ${proposal.searchPages} search ` +
          `page(s) failed, so this list may be short an edition. \`--retry\` ` +
          `will finish it._`
      );
      lines.push("");
    }

    lines.push("| approve | ISBN-13 | title | publisher | year | pages |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const candidate of proposal.candidates) {
      lines.push(
        `| ☐ | \`${candidate.isbn}\` | ${cell(candidate.fullTitle)} | ` +
          `${cell(candidate.publisher)} | ${candidate.year ?? "—"} | ` +
          `${candidate.pageCount} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
};

/**
 * One table cell. A book title really can contain a `|` — and a Google Books
 * subtitle can contain a newline — either of which silently breaks the row it
 * is in and every row after it, which is a bad way for a file somebody is
 * meant to read carefully to fail.
 */
const cell = (value) =>
  value === undefined || value === null || value === ""
    ? "—"
    : String(value).replace(/\s+/g, " ").replace(/\|/g, "\|").trim();

/** The title inside the guard's refusal, for a run that has no fresh response. */
const refusedTitleOf = (proposal) =>
  /the apiRef names "([^"]*)"/.exec(proposal.refusal ?? "")?.[1];

/**
 * Which filter took how many, by the rejection's `label` rather than by its
 * sentence — the sentences quote the volume's own title, so counting those
 * would count every volume separately and say nothing.
 */
const countsByLabel = (rejected) => {
  const counts = new Map();
  for (const { label } of rejected) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
};

/**
 * `?` offered, `-` searched and nothing survived, `!` not properly searched.
 *
 * The third is the one that has to exist. A rate-limited search comes back
 * empty, and an empty search reported as "no English edition" is a finding
 * invented out of an unanswered question — which is the distinction
 * ../load_adapter.js draws for every other API call in this folder.
 */
const mark = (proposal) =>
  proposal.candidates.length > 0 ? "?" : proposal.searchFailures > 0 ? "!" : "-";

const describeProposal = (proposal) => {
  if (proposal.candidates.length > 0) {
    return proposal.candidates
      .map((c) => `${c.isbn} (${c.publisher}, ${c.year}, ${c.pageCount}pp)`)
      .join(" | ");
  }
  if (proposal.searchFailures > 0) {
    return (
      `not searched — ${proposal.searchFailures} of ${proposal.searchPages} ` +
      `search page(s) failed`
    );
  }
  return `no candidate survived ${proposal.rejected.length} volume(s)`;
};

const summarize = (proposals) => {
  const offered = proposals.filter((p) => p.candidates.length > 0);
  const single = offered.filter((p) => p.candidates.length === 1);
  const unsearched = proposals.filter(
    (p) => p.candidates.length === 0 && p.searchFailures > 0
  );

  console.log(
    `\n${proposals.length} refused book(s): ${offered.length} with a ` +
      `candidate (${single.length} with exactly one), ` +
      `${proposals.length - offered.length - unsearched.length} with none, ` +
      `${unsearched.length} not searched.`
  );

  // Non-zero, because a run that could not ask is not a run that found
  // nothing, and the difference is invisible in a count of candidates. The
  // backfill exits this way when every call it made failed, for the reason.
  if (unsearched.length > 0) {
    console.error(
      `\n${unsearched.length} book(s) were not searched: Google Books refused ` +
        `the request, which is almost always a spent rate limit. They are not ` +
        `books without an English edition, and the file says so rather than ` +
        `listing them as having no candidate. Re-run with --retry=<this file> ` +
        `once the limit has reset.`
    );
    process.exitCode = 1;
  }

  console.log(
    "Nothing has been written. Read the file, set `approved`, then re-run " +
      "with --apply --from=<file>."
  );
};

///////////////////////////////////////////////////////////////////////////////
// Apply

const applyPhase = async (db) => {
  console.log(
    options.apply
      ? "APPLY MODE: the books collection will be modified."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  const proposals = JSON.parse(fs.readFileSync(options.from, "utf8"));
  const works = await db.collection(books.works).find().toArray();

  const verifications = await verifyApprovals(proposals);
  const plan = planRepoint(books, works, proposals, verifications);

  if (plan.blocked) {
    console.error(`REFUSED: ${plan.blocked}`);
    process.exitCode = 1;
    return;
  }

  report(plan);

  if (!options.apply || plan.repoints.length === 0) {
    if (plan.repoints.length > 0) {
      console.log(
        "\nTake a fresh snapshot with backup_database.js, verify it with " +
          "verify_backup.js --live, then re-run with --apply."
      );
    }
    return;
  }

  backup(works);
  await write(db, plan);
  await verify(db, plan, works);
};

/**
 * Asks Google Books about each approved ISBN, once, right before the write.
 *
 * The answer is what `planRepoint` checks the stored title against, so an
 * approval for an ISBN that has since been reassigned, or that was mistyped
 * into a real but different book, never reaches the database. A failed
 * retrieve is recorded with its error rather than dropped: "Google Books would
 * not answer" and "Google Books says another book" are different, and only the
 * second is a finding.
 */
const verifyApprovals = async (proposals) => {
  const isbns = [
    ...new Set(
      proposals
        .map((proposal) => proposal?.approved)
        .filter((isbn) => typeof isbn === "string" && isbn.trim() !== "")
        .map((isbn) => isbn.trim())
    ),
  ];

  if (isbns.length === 0) return new Map();

  const adapter = loadAdapter(books);
  if (!adapter) return new Map();

  console.log(`\nConfirming ${isbns.length} approved ISBN(s) with Google Books.`);

  const verifications = new Map();
  for (const [index, isbn] of isbns.entries()) {
    if (index > 0) await sleep(delay());
    const result = await adapter.retrieve(isbn);
    verifications.set(
      isbn,
      result.isErr()
        ? { error: describeError(result.error) }
        : { fresh: result.value }
    );
  }

  return verifications;
};

const report = (plan) => {
  for (const repoint of plan.repoints) {
    console.log(
      `\n  ~ ${repoint.title}: ${repoint.oldRef ?? "(none)"} -> ${repoint.newRef}`
    );
    if (repoint.unset.length > 0) {
      console.log(
        `      ${options.apply ? "clearing  " : "would clear"} ` +
          repoint.unset.map(({ field, value }) => `${field}=${value}`).join(", ")
      );
    }
    if (repoint.removedUrls.length > 0) {
      console.log(`      dropping ${repoint.removedUrls.length} edition link(s)`);
    }
  }

  for (const { title, isbn, reason } of plan.skipped) {
    console.log(`\n  ! ${title} (${isbn}): ${reason}`);
  }

  console.log(
    `\n${plan.totals.approved} approval(s): ${plan.totals.repointed} ` +
      `${options.apply ? "repointed" : "would be repointed"}, ` +
      `${plan.skipped.length} skipped, ${plan.totals.values} stored value(s) ` +
      `cleared. ${plan.unapproved} proposal(s) not approved.`
  );
};

/**
 * One `bulkWrite`: every book keeps a different array, so there is no group
 * these are one operation for.
 *
 * No `metadataUpdatedDate` is written and the plan unsets the one that is
 * there — the same reasoning `repair_shared_refs.js` gives. An adapter has not
 * said anything about this book yet; it is about to be asked for the first
 * time under an id that names it.
 */
const write = async (db, plan) => {
  const operations = plan.repoints.map((repoint) => ({
    updateOne: {
      filter: { _id: repoint._id },
      update: {
        $set: {
          apiRefs: repoint.apiRefs,
          ...(repoint.removedUrls.length > 0
            ? { externalUrls: repoint.externalUrls }
            : {}),
        },
        ...(repoint.unset.length > 0
          ? {
              $unset: Object.fromEntries(
                repoint.unset.map(({ field }) => [field, ""])
              ),
            }
          : {}),
      },
    },
  }));

  const result = await db.collection(books.works).bulkWrite(operations);
  console.log(`\n  wrote ${result.modifiedCount} book(s)`);

  if (result.modifiedCount !== plan.repoints.length) {
    console.error(
      `  expected ${plan.repoints.length}, modified ${result.modifiedCount} — ` +
        `something else is writing to ${books.works}.`
    );
    process.exitCode = 1;
  }
};

/**
 * What the run did, asked of the database rather than inferred from the plan.
 *
 * The last check is the one this script owes above all others: no ISBN in the
 * whole collection is held by two books. A repoint is refused for that reason
 * three times over — when a candidate is offered, when an approval is planned
 * and here — because a shared identity ref is the state #290 found and #308
 * finished cleaning up, and the cheapest place to notice one is before anybody
 * has to diagnose it.
 */
const verify = async (db, plan, before) => {
  const works = await db.collection(books.works).find().toArray();
  const byId = new Map(works.map((work) => [String(work._id), work]));
  const problems = [];

  for (const repoint of plan.repoints) {
    const work = byId.get(String(repoint._id));
    if (!work) {
      problems.push(`${repoint.title} is gone from ${books.works}`);
      continue;
    }
    if (findApiRef(work.apiRefs, "ISBN") !== repoint.newRef) {
      problems.push(
        `${repoint.title} is filed under ` +
          `${findApiRef(work.apiRefs, "ISBN")}, not ${repoint.newRef}`
      );
    }
    for (const { field } of repoint.unset) {
      if (work[field] !== undefined) {
        problems.push(`${repoint.title} still carries a ${field}`);
      }
    }
  }

  const repointed = new Set(plan.repoints.map((r) => String(r._id)));
  for (const work of before) {
    if (repointed.has(String(work._id))) continue;
    const now = byId.get(String(work._id));
    if (JSON.stringify(now?.apiRefs) !== JSON.stringify(work.apiRefs)) {
      problems.push(`${displayTitle(work)} was not in the plan and changed`);
    }
  }

  for (const [isbn, ids] of refOwners(books, works)) {
    if (ids.length > 1) {
      problems.push(`${isbn} is now held by ${ids.length} books: ${ids.join(", ")}`);
    }
  }

  if (problems.length === 0) {
    console.log(
      `  verified: ${plan.repoints.length} repointed, every other book's ` +
        `refs unchanged, no ISBN held by two books`
    );
    return;
  }

  console.error(`\n  VERIFICATION FAILED:`);
  for (const problem of problems) console.error(`    ${problem}`);
  process.exitCode = 1;
};

const backup = (documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${books.works}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`  backed up ${documents.length} documents to ${file}`);
};

///////////////////////////////////////////////////////////////////////////////

const delay = () => options.delayMs ?? books.defaultDelayMs;

/** The key goes on every request when there is one, as the adapter does it. */
const urlKey = () =>
  process.env.GOOGLE_API_KEY ? `&key=${process.env.GOOGLE_API_KEY}` : "";

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
