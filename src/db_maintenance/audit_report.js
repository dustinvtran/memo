/**
 * @file What the audit's summary says, and which of its findings are actually
 * problems.
 *
 * Pure and dependency-free, so the classification is unit tested rather than
 * argued about in front of a terminal — see audit_report.test.js. The database
 * reads live in scripts/audit_database.js.
 *
 * The split exists because the summary used to print ten counts in one flat
 * list, and two of the lines next to each other were:
 *
 *     5  entries with no workRef
 *     0  entries with a dangling workRef
 *
 * Only the second is a broken reference. The first is a supported state — an
 * entry the user typed in rather than picked from a search result carries its
 * own metadata in `overrides` and never had a work to point at. Formatted
 * identically and one line apart, the two were read as one finding, and the 23
 * user-authored entries in the database were reported as 23 corrupted ones.
 */

/**
 * Every line of the summary, in the order it is printed.
 *
 * `kind` is `"problem"` for something that wants fixing and `"note"` for a
 * count that is worth knowing and is not damage. A note is not a milder
 * problem: nothing in the database is wrong because of it, and no script
 * should be written to make it go away.
 *
 * `label` takes the collection descriptor because one of them names the
 * apiRef prefix the type is refreshed by.
 *
 * `only` and `except` restrict a finding to one type or withhold it from one.
 * They are the two halves of the same idea and both are in use: the playtime
 * line belongs to games alone, and the collision line belongs to every type
 * but tv — where sharing a show id between seasons is how the site works, so
 * a collision is not a thing that can be found.
 *
 * @type {Array<{
 *   key: string,
 *   kind: "problem" | "note",
 *   label: (collection: any) => string,
 *   only?: string,
 *   except?: string,
 * }>}
 */
const FINDINGS = [
  // First, because it is the one that means a user's row renders empty.
  {
    key: "entriesWithDanglingWorkRef",
    kind: "problem",
    label: () => "entries whose workRef names a work that is gone",
  },
  {
    key: "noApiRef",
    kind: "problem",
    label: (c) => `no ${c.retrievePrefix}__ ref (cannot be refreshed)`,
  },
  {
    key: "legacyObjectApiRefs",
    kind: "problem",
    label: () => "apiRefs still stored as objects",
  },
  {
    key: "missingFields",
    kind: "problem",
    label: () => "missing metadata fields",
  },
  {
    key: "corruptFields",
    kind: "problem",
    label: () => "corrupt field values",
  },
  // Separate from `corruptFields` because the two ask different questions.
  // That one asks whether a value has the right *shape*; a duration of
  // 2939328000000000 is a perfectly good number and passed it for years while
  // the playtime column rendered 5.6 billion hours. See
  // ../duration_plausibility.js.
  {
    key: "implausibleDurations",
    kind: "problem",
    label: () => "durations that cannot be true",
  },
  {
    key: "gamesMissingPlaytimeLink",
    kind: "problem",
    label: () => "playtime with nothing to link it to",
    only: "games",
  },
  // The three things that used to be one line. "44 duplicate works sharing an
  // apiRef" was a number nobody could act on: nineteen of those groups were tv
  // seasons, which are correct by design and can never go to zero, and
  // twenty-five were works filed under another work's id, which is neither a
  // duplicate nor something `dedupe_works.js` may touch. See
  // ../shared_ref_check.js and #290.
  {
    key: "duplicateWorks",
    kind: "problem",
    label: () => "duplicate works sharing an apiRef",
  },
  {
    key: "sharedIdentityRefs",
    kind: "problem",
    label: () => "ids shared by works that are not the same work",
    except: "tv",
  },
  // The other direction, and a third meaning again: one work filed under two
  // *different* ids shares no key with itself, so neither line above can see
  // it. Split by what discriminates, because a title is a much weaker key than
  // an id — see ../title_year_check.js and #319.
  {
    key: "titleYearDuplicates",
    kind: "problem",
    label: () => "one work under two ids (same title, year and duration)",
  },
  {
    key: "titleYearUnidentified",
    kind: "problem",
    label: (c) =>
      `same title and year, and one of them has no ${c.retrievePrefix}__ ref`,
  },
  // A fifth meaning of the same defect, and the one with no database-only
  // shape at all: one document under one id that names something else agrees
  // with itself perfectly, so the three findings above are blind to it and
  // only the API can be asked. These three counts are **zero unless
  // `--verify-titles` was passed**, which is the price of a finding that costs
  // 1,400 calls to look for; the script says so on a run that did not.
  // ../title_match_check.js and #327.
  {
    key: "titleRefContained",
    kind: "problem",
    label: (c) =>
      `${c.retrievePrefix}__ ref names a title one of the two contains`,
  },
  {
    key: "titleRefDifferent",
    kind: "problem",
    label: (c) =>
      `${c.retrievePrefix}__ ref names a different work (cannot be refreshed)`,
  },
  {
    key: "orphanReviews",
    kind: "problem",
    label: () => "reviews whose entry is gone (unreachable)",
  },
  // Notes. None is damage; see the header comment.
  // The stored title needed forgiving, which is worth reading, but #327's
  // normalisation forgives it and the work refreshes — so this is a note in
  // the same sense the tv line below is one, and not a milder problem.
  {
    key: "titleRefSpelling",
    kind: "note",
    label: (c) =>
      `${c.retrievePrefix}__ ref names the same title, spelled differently`,
  },
  {
    key: "entriesWithoutWorkRef",
    kind: "note",
    label: () => "entries with no linked work (user-authored, expected)",
  },
  {
    key: "expectedSharedRefs",
    kind: "note",
    label: () => "works sharing a show id (separate seasons, expected)",
    only: "tv",
  },
  {
    key: "orphanWorks",
    kind: "note",
    label: () => "cached works no entry points at",
  },
  // A note, and not a milder problem, for the same reason the tv line above is
  // one: `mother|2009` is three different films and `stalker|1979` is two, so
  // this count can never go to zero and no script should be written to make
  // it. `--verify-title-years` is how one of these becomes a decision.
  {
    key: "titleYearUndecided",
    kind: "note",
    label: () => "same title and year, different ids (may be different works)",
  },
];

/**
 * The summary lines for one collection, already split.
 *
 * A finding whose `only` doesn't match the type, or whose `except` does, is
 * left out entirely rather than printed as a zero — which is how the playtime
 * line has always behaved, and is the only honest thing to do with a count
 * that cannot be anything but zero. A key the result doesn't carry counts as
 * zero rather than throwing: the report is a diagnostic, and half of one still
 * beats a stack trace.
 *
 * @type {(collection: any, result: object) => {
 *   problems: Array<{ key: string, label: string, count: number }>,
 *   notes: Array<{ key: string, label: string, count: number }>,
 * }}
 */
const toSummary = (collection, result) => {
  const lines = FINDINGS.filter(
    (finding) =>
      (finding.only === undefined || finding.only === collection.type) &&
      finding.except !== collection.type
  ).map((finding) => ({
    key: finding.key,
    kind: finding.kind,
    label: finding.label(collection),
    count: (result?.[finding.key] ?? []).length,
  }));

  return {
    problems: lines.filter((line) => line.kind === "problem").map(withoutKind),
    notes: lines.filter((line) => line.kind === "note").map(withoutKind),
  };
};

/** How many findings across a whole report are worth someone's attention. */
const countProblems = (collections, report) =>
  collections.reduce(
    (total, collection) =>
      total +
      toSummary(collection, report[collection.type]).problems.reduce(
        (n, line) => n + line.count,
        0
      ),
    0
  );

module.exports = {
  FINDINGS,
  toSummary,
  countProblems,
};

///////////////////////////////////////////////////////////////////////////////

const withoutKind = ({ kind: _kind, ...line }) => line;
