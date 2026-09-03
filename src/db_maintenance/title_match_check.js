/**
 * @file What it means when the id a work is filed under resolves to a
 * different title.
 *
 * ./shared_ref_check.js finds a work wearing another work's id by noticing
 * that two documents wear the same one, and ./title_year_check.js finds it by
 * noticing that one work sits under two. Both are database-only questions, and
 * both are blind to the commonest case of all: **one** document under **one**
 * id that belongs to something else. Nothing in the database disagrees with
 * itself there, so nothing looked.
 *
 * `mergeWork` in ./work_metadata_merge.js has been finding them all along and
 * throwing the answer away. Its title guard (#290) refuses to merge a response
 * whose title disagrees with the stored one, and a `--missing-only` dry run
 * over production refuses 357 works — 23% of the library. The refusal is
 * correct and the work is genuinely unrefreshable, but the only trace of it is
 * a line in a backfill log: the audit's "cannot be refreshed" count is about
 * works with no identity ref at all, and these have one, and it resolves.
 * #327.
 *
 * So the same question is asked deliberately here, one call per work, and the
 * answers are split into the three things a disagreement can be:
 *
 *   - **Spelling.** The two titles are the same once `comparableTitle` has had
 *     them — a leading article, a diacritic, a series suffix, `Seven` against
 *     `7`. `titlesAgree` now passes these, so they are no longer refused;
 *     they are reported because a stored title that needed forgiving is still
 *     a stored title somebody should fix.
 *   - **Containment.** One title contains the other, and this bucket is
 *     genuinely mixed, which is the whole reason it is its own bucket.
 *     `Heart of Darkness` against `Heart of Darkness By Joseph Conrad` is one
 *     book; `House of Flying Daggers` against `Making of House of Flying
 *     Daggers` and `Ex Machina` against `Digitaria Ex Machina` are two works
 *     apiece. Containment is exactly the shape a search-result mistake takes,
 *     so it can never be forgiven wholesale — and it cannot be condemned
 *     wholesale either, so it is triage rather than a finding to act on.
 *   - **Difference.** Neither, and most of these are #290's damage:
 *     `Pinnochio` under the id for `The Adventures of Buratino`, `Ghostrider`
 *     under `Ghost Rider 2 Goes Wild`.
 *
 * Detect and classify, like #299 and #322 before it. Nothing here decides a
 * write: which of a stored title and an API's is the right name for the work
 * is a human's call, and correcting the stored one by hand is what lets the
 * next backfill through.
 *
 * Pure and dependency-free like its neighbours — the reads and the API calls
 * live in scripts/audit_database.js and ./load_adapter.js — so the
 * classification is covered by the no-install suite
 * (./title_match_check.test.js).
 */
const {
  findApiRef,
  displayTitle,
  titlesOf,
  comparableTitlesOf,
} = require("./work_collections");
const { describeWork } = require("./shared_ref_check");

/**
 * The buckets in the order they are reported: the verdict each holds, the key
 * the audit files it under, and the heading to print above it.
 *
 * The report key lives here rather than in scripts/audit_database.js so that
 * ../audit_report.js's summary lines and the sections printed beneath them
 * cannot come to name different things — ./title_match_check.test.js asserts
 * that every key in this list is a finding that file knows about.
 *
 * `same` is not here: an id that names the work filed under it is the ordinary
 * case and not a finding.
 */
const TITLE_MATCH_BUCKETS = [
  {
    bucket: "spelling",
    key: "titleRefSpelling",
    heading: "the same title, spelled differently (merged since #327)",
  },
  {
    bucket: "contained",
    key: "titleRefContained",
    heading: "one title contains the other (either could be a different work)",
  },
  {
    bucket: "different",
    key: "titleRefDifferent",
    heading: "a different title entirely",
  },
];

/**
 * What the id said about the work filed under it.
 *
 *   `"same"`      — the titles already agreed, letter for letter once
 *                   `normalizeTitle` has had them. Nothing to report.
 *   `"spelling"`  — they agree only after `comparableTitle`. This is exactly
 *                   the set #327's normalisation recovered, which is why the
 *                   two spellings are compared rather than just the loose one.
 *   `"contained"` — one is a substring of the other.
 *   `"different"` — neither.
 *   `undefined`   — one of the two carries no title, so nothing was compared.
 *                   Not a verdict, for the same reason `titlesAgree` answers
 *                   undefined: "don't know" is not "they differ", and a work
 *                   with no title is the ordinary case the backfill exists for.
 *
 * @type {(work: any, fresh: any) => "same" | "spelling" | "contained" | "different" | undefined}
 */
const classifyTitleMatch = (work, fresh) => {
  const ours = comparableTitlesOf(work);
  const theirs = comparableTitlesOf(fresh);
  if (ours.length === 0 || theirs.length === 0) return undefined;

  if (agreesUnder(titlesOf, work, fresh)) return "same";
  if (ours.some((title) => theirs.includes(title))) return "spelling";
  if (eitherContainsTheOther(ours, theirs)) return "contained";
  return "different";
};

/**
 * The works worth asking about, with the id to ask: every document carrying
 * the ref its type is retrieved by.
 *
 * `findApiRef` and `collection.retrievePrefix`, which is the pair
 * scripts/backfill_work_metadata.js uses to decide what to retrieve — so the
 * set asked here is the set the backfill would refuse from, and the two counts
 * can be compared. A work without that ref is left out because it is already
 * the audit's `noApiRef` finding, and there is nothing to ask.
 *
 * @type {(collection: any, works: any[]) => Array<{ work: any, apiRef: string, ref: string }>}
 */
const titleMatchTargets = (collection, works) =>
  works.flatMap((work) => {
    const ref = findApiRef(work.apiRefs, collection.retrievePrefix);
    if (!ref) return [];
    return [{ work, apiRef: `${collection.retrievePrefix}__${ref}`, ref }];
  });

/**
 * One work, its id, and what the id turned out to name.
 *
 * Shaped like ./shared_ref_check.js's checks — `describeWork` for the
 * document, `apiTitle` for the answer — so a reader who has read one of the
 * audit's `--json` sections can read this one.
 * @type {(target: { work: any, apiRef: string, ref: string }, fresh: any) => object}
 */
const resolveTitleMatch = ({ work, apiRef, ref }, fresh) => ({
  ...describeWork(work),
  apiRef,
  ref,
  apiTitle: displayTitle(fresh),
  verdict: classifyTitleMatch(work, fresh),
});

/**
 * The checks split by verdict, with the two kinds of non-answer kept out of
 * all three buckets and out of each other.
 *
 * `unanswered` is an id the adapter would not resolve — a dead ISBN, a rate
 * limit — and `uncompared` is one it resolved to a response with no title, or
 * a work that has none. Neither is evidence of anything, and folding either
 * into `different` would report a network problem as a misfiled work.
 *
 * @type {(checks: object[]) => {
 *   same: object[],
 *   spelling: object[],
 *   contained: object[],
 *   different: object[],
 *   unanswered: object[],
 *   uncompared: object[],
 * }}
 */
const classifyTitleMatches = (checks) => {
  const result = {
    same: [],
    spelling: [],
    contained: [],
    different: [],
    unanswered: [],
    uncompared: [],
  };

  for (const check of checks) {
    if (check.error !== undefined) result.unanswered.push(check);
    else if (check.verdict === undefined) result.uncompared.push(check);
    else result[check.verdict].push(check);
  }

  return result;
};

module.exports = {
  TITLE_MATCH_BUCKETS,
  classifyTitleMatch,
  titleMatchTargets,
  resolveTitleMatch,
  classifyTitleMatches,
};

///////////////////////////////////////////////////////////////////////////////

/** Either title of one matching either title of the other, under one spelling. */
const agreesUnder = (titlesFor, a, b) => {
  const theirs = titlesFor(b);
  return titlesFor(a).some((title) => theirs.includes(title));
};

/**
 * Containment, and never equality — the two are already separate verdicts, and
 * a substring test that also answered true for a match would collapse them.
 *
 * A very short title is inside almost everything, so containment is only
 * claimed when the shorter of the two is at least three characters long. That
 * is not a heuristic about works: it is what stops `Up` from being called a
 * near-miss for every id that resolves to a `Supernatural`, and leaves such a
 * pair where it belongs, in `different`.
 */
const eitherContainsTheOther = (ours, theirs) =>
  ours.some((ourTitle) =>
    theirs.some((theirTitle) => {
      const [shorter, longer] =
        ourTitle.length <= theirTitle.length
          ? [ourTitle, theirTitle]
          : [theirTitle, ourTitle];
      return shorter.length >= 3 && shorter !== longer && longer.includes(shorter);
    })
  );
