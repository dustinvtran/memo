#!/usr/bin/env node
/**
 * @file Searches each work that has no identity ref, and each entry that has
 * no work, and writes a worklist of candidates for a person to confirm.
 *
 * **Read-only. It writes two files and nothing else**, which is the point:
 * ../work_ref_proposal.js explains why nothing here picks a candidate, and the
 * short of it is that a raw search is wrong often enough that taking its first
 * hit would be #290 arriving by a new route — TMDB answers `Hero` with `THE
 * RIBBON HERO` first, and IGDB leads with a DCS World campaign.
 *
 * The output pairs with scripts/set_work_ref.js, which takes the confirmed
 * file and asks the API the same question again at the moment it writes.
 *
 * Usage:
 *   node scripts/propose_work_refs.js --out=worklist
 *   node scripts/propose_work_refs.js --out=worklist --only=films,games
 *
 * Flags:
 *   --out=<stem>    writes <stem>.json and <stem>.md (default: work_refs)
 *   --only=a,b      restrict to these collections
 *   --limit=N       stop after N works per collection, for a trial run
 *   --delay=MS      override the collection pause; Google Books needs more
 *                   than its usual 1000ms when several queries run per work
 *   --max-queries=N try at most N of the title variations (default 3)
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  selectCollections,
  parseArgs,
  findApiRef,
  sleep,
} = require("../work_collections");
const { loadAdapter, describeError } = require("../load_adapter");
const { rankCandidates, queriesFor, STRONG } = require("../work_ref_proposal");

const main = async () => {
  const args = parseArgs(process.argv);
  const stem = String(args.out ?? "work_refs");
  const limit = Number(args.limit) || Infinity;
  const delayOverride = Number(args.delay) || undefined;
  // Three is where the returns fall off and the 429s start: the fourth and
  // fifth variations are the loosest, and running them for every work is what
  // rate-limited Google Books on 64 of 76 books.
  const maxQueries = Number(args["max-queries"]) || 3;
  const collections = selectCollections(
    args.only === undefined || args.only === true
      ? undefined
      : String(args.only).split(",")
  );

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecateErrors: true },
  });
  await client.connect();
  const db = client.db("memo");
  const rows = [];

  try {
    for (const collection of collections) {
      const adapter = loadAdapter(collection);
      if (!adapter) continue;

      const works = await db.collection(collection.works).find({}).toArray();
      const entries = await db.collection(collection.entries).find({}).toArray();
      const counts = entries.reduce(
        (acc, entry) =>
          acc.set(String(entry.workRef), (acc.get(String(entry.workRef)) ?? 0) + 1),
        new Map()
      );

      // Two populations, one question. A work with no identity ref exists and
      // draws on the site but can never refresh; an entry with no workRef has
      // no work at all and carries what was typed in its overrides. Both need
      // somebody to name an id, so both are searched the same way.
      const targets = [
        ...works
          .filter((work) => !findApiRef(work.apiRefs, collection.retrievePrefix))
          .map((work) => ({
            kind: "work",
            id: String(work._id),
            doc: work,
            entries: counts.get(String(work._id)) ?? 0,
          })),
        ...entries
          .filter((entry) => entry.workRef == null || entry.workRef === "")
          .map((entry) => ({ kind: "entry", id: String(entry._id), doc: entry, entries: 1 })),
      ];
      const slice = limit === Infinity ? targets : targets.slice(0, limit);

      console.log(`${collection.type}: searching ${slice.length}`);

      let searched = 0;
      for (const target of slice) {
        const title = titleFor(target.doc);
        let candidates = [];
        let error;
        let usedQuery;
        const gathered = [];

        // Each query is looser than the one before, so the first that answers
        // is the most specific one that could. A stored title is often not a
        // search term: TMDB returns nothing for `Red Cliff: Part One` and the
        // film for `Red Cliff`. See ../work_ref_proposal.js.
        for (const query of queriesFor(title).slice(0, maxQueries)) {
          // The crawl's own pause for this collection. This walks the same
          // APIs and has no more right to their quota than the nightly job.
          if (searched > 0) await sleep(delayOverride ?? collection.defaultDelayMs);
          searched += 1;

          const result = await adapter.search(query);
          if (result.isErr()) {
            error = describeError(result.error);
            continue;
          }

          // Results are pooled across the variations rather than taken from
          // the first that answers anything. `Doom mod` answers with unrelated
          // Doom mods and would have ended the search before `Sigil` ran, so a
          // query returning *something* is not a query returning the right
          // thing. Ranking the pool lets the better query win whenever it is
          // asked, in whatever order.
          gathered.push(...result.value);
          error = undefined;
          if (usedQuery === undefined && result.value.length > 0) usedQuery = query;

          // Stopping early only on a match strong enough that no looser
          // variation could improve on it — which is most of them, and is what
          // keeps this inside the API budgets.
          const best = rankCandidates(target.doc, gathered)[0];
          if (best && best.score >= STRONG) break;
        }
        candidates = rankCandidates(target.doc, gathered);

        rows.push({
          kind: target.kind,
          type: collection.type,
          [target.kind]: target.id,
          storedTitle: title ?? null,
          // Which of the fallbacks found these, so a reviewer can see when
          // the match came from a looser search than the stored title.
          searchedFor: usedQuery ?? null,
          storedYear:
            target.doc?.releaseYear ?? target.doc?.overrides?.releaseYear ?? null,
          entries: target.entries,
          ...(target.kind === "entry" ? { overrides: target.doc.overrides ?? {} } : {}),
          ...(error ? { searchError: error } : {}),
          candidates: candidates.map((candidate) => ({
            ref: `${collection.retrievePrefix}__${candidate.ref}`,
            title: candidate.title,
            year: candidate.year,
            score: candidate.score,
            titleAgrees: candidate.titleAgrees,
          })),
          // What a person fills in. Left empty on purpose — see
          // ../work_ref_proposal.js for why nothing here chooses.
          ref: "",
          retitleWorkTo: "",
          entryTitle: "",
        });
      }
    }
  } finally {
    await client.close();
  }

  fs.writeFileSync(`${stem}.json`, JSON.stringify(rows, null, 1));
  fs.writeFileSync(`${stem}.md`, markdown(rows));
  report(rows, stem);
};

/** The title to search: a work's own, or what an unlinked entry had typed. */
const titleFor = (doc) => {
  const title =
    doc?.englishTranslatedTitle ??
    doc?.title ??
    doc?.overrides?.englishTranslatedTitle ??
    doc?.overrides?.originalTitle;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
};

const HEADER = [
  "# memo — works and entries needing an identity link",
  "",
  "Candidates are suggestions, not answers: a raw search leads with the wrong",
  "title often enough that taking it would be the bug this guards against.",
  "Confirm each one.",
  "",
  "In the JSON beside this file, per row:",
  "",
  "- **`ref`** — the id you have chosen. Leave it empty to skip the row.",
  "- **`retitleWorkTo`** — the API's own title. Needed only when the candidate",
  "  you picked says `agrees: **no**`, which is the guard refusing a title it",
  "  cannot tell apart from a wrong id. Naming the API's title is how you say",
  "  you checked.",
  "- **`entryTitle`** — what the list should read, when that is your own naming",
  "  rather than the API's. It goes on the entry as an override, exactly as a",
  "  season does, so the work stays refreshable and the list still reads the",
  "  way you want.",
  "",
];

const markdown = (rows) => {
  const out = [...HEADER];
  for (const row of rows) {
    const what = row.kind === "work" ? "work" : "entry";
    const year = row.storedYear ? ` (${row.storedYear})` : "";
    const held = `${row.entries} entr${row.entries === 1 ? "y" : "ies"}`;
    out.push(
      `### ${row.storedTitle ?? "(no title)"}${year}  ·  \`${row.type}\` ${what} \`${row[what]}\`  ·  ${held}`,
      ""
    );
    if (row.searchError) {
      out.push(`> the search failed: ${row.searchError}`, "");
      continue;
    }
    if (row.candidates.length === 0) {
      out.push("> nothing found — this one needs an id by hand", "");
      continue;
    }
    out.push("| score | agrees | ref | year | candidate |", "|---:|---|---|---:|---|");
    for (const candidate of row.candidates) {
      const agrees =
        candidate.titleAgrees === true
          ? "yes"
          : candidate.titleAgrees === false
            ? "**no**"
            : "?";
      const title = String(candidate.title).split("|").join("\\|");
      out.push(
        `| ${candidate.score} | ${agrees} | \`${candidate.ref}\` | ${candidate.year ?? ""} | ${title} |`
      );
    }
    out.push("");
  }
  return out.join("\n");
};

const report = (rows, stem) => {
  const confident = rows.filter(
    (row) => row.candidates[0]?.score >= 90 && row.candidates[0]?.titleAgrees === true
  );
  const needsRetitle = rows.filter(
    (row) =>
      row.candidates.length > 0 &&
      row.candidates.every((candidate) => candidate.titleAgrees === false)
  );
  const nothing = rows.filter((row) => row.candidates.length === 0);
  const rest = rows.length - confident.length - needsRetitle.length - nothing.length;

  console.log(`\nwrote ${stem}.json and ${stem}.md — ${rows.length} rows`);
  console.log(`  one strong candidate the guard would accept: ${confident.length}`);
  console.log(`  candidates found, every one refused on its title: ${needsRetitle.length}`);
  console.log(`  nothing found at all: ${nothing.length}`);
  console.log(`  a choice between candidates: ${rest}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
