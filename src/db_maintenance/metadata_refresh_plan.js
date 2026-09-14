/**
 * @file Which works a refresh run spends its API calls on, in what order, and
 * how far behind the library as a whole has fallen.
 *
 * Pure and dependency-free like its neighbours, because under a schedule this
 * is the half that decides whether a crawl finishes at all. The I/O is in
 * scripts/backfill_work_metadata.js; the decision about what to *write* once a
 * work has been fetched is ./work_metadata_merge.js. This module only picks.
 *
 * The selection used to be three lines inside the script — a predicate over
 * `options` and a `slice` — and that was enough while a run was somebody
 * watching a terminal until it finished. It is not enough for #3's periodic
 * crawl, where a run is a slice of a few hundred works out of ~3,900 and the
 * next run has to carry on from where this one stopped, on a rate limit that
 * gives Google Books about a thousand calls a day.
 */
const { hasGaps } = require("./work_metadata_merge");

/** Six months, which is the default `--max-age-days`. */
const DEFAULT_MAX_AGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a work was last *asked about*, or undefined for one that never has
 * been.
 *
 * The field is called `metadataUpdatedDate`, which reads like "when this work
 * last changed", and that is not what it holds: the backfill has always
 * stamped it on a work the API confirmed was already current, without writing
 * a field. "Last checked" is the meaning the data actually carries, and the
 * one every reader here wants — a work whose year has been right for two years
 * is not overdue, it is correct.
 *
 * Renaming it would be a write to the ~1,380 works that already carry one,
 * to fix a comment, so the meaning is pinned here instead and the name stays.
 */
const lastCheckedAt = (work) =>
  typeof work?.metadataUpdatedDate === "number"
    ? work.metadataUpdatedDate
    : undefined;

/**
 * Whether a work is worth an API call on this run.
 *
 * The two modes answer different questions and neither is a weaker form of the
 * other. `missingOnly` asks "is anything absent", which is a property of the
 * document and has nothing to do with when it was last read; the age mode asks
 * "has anyone looked lately", which is the only question that can notice a
 * release date that has stopped being TBD (#333) or a playtime that has been
 * re-estimated since. A work can be complete and years out of date, and
 * `--missing-only` — every run applied so far — cannot see it by construction.
 */
const isDue = (collection, work, options = {}) => {
  if (options.missingOnly === true) return hasGaps(collection, work);
  if (options.force === true) return true;
  return isStale(work, options);
};

/**
 * Nobody has looked at this work inside the window. The age half of `isDue` on
 * its own, so that the audit can ask it about a collection without pretending
 * to be a run and without a second copy of the rule to drift.
 */
const isStale = (
  work,
  { maxAgeMs = DEFAULT_MAX_AGE_DAYS * DAY_MS, now = Date.now() } = {}
) => {
  const checkedAt = lastCheckedAt(work);
  return checkedAt === undefined || now - checkedAt > maxAgeMs;
};

/**
 * The due works, longest-unchecked first, and the slice of them this run will
 * actually fetch.
 *
 * **The order is the point.** A `find()` returns works in whatever order the
 * server likes, and `slice(0, limit)` over that was fine for a run that
 * processed every candidate. Under a schedule it is not: the run that takes an
 * arbitrary few hundred of the due works can leave a work unfetched for months
 * while its neighbours are re-fetched twice, and two runs over the same data
 * need not pick the same slice, so nothing about a crawl's progress can be
 * predicted or resumed. Oldest-first makes a sliced crawl a queue: whatever
 * waited longest goes next, and a run that dies halfway is a run that got
 * through fewer of the queue rather than a run whose work has to be found
 * again.
 *
 * Never-checked sorts before everything, which is where the first crawl comes
 * from — as of the 2026-09-03 run `metadataUpdatedDate` is absent on all 1,560
 * films, all 510 tv shows and all 696 books, so the whole library is in that
 * bucket and the queue is simply "the library". `_id` breaks the tie, so the
 * order within it is stable across runs rather than the server's.
 *
 * @type {(collection: any, works: any[], options?: object) => { due: any[], selected: any[] }}
 */
const selectForRefresh = (collection, works, options = {}) => {
  const { limit = Infinity } = options;

  const due = (Array.isArray(works) ? works : [])
    .filter((work) => isDue(collection, work, options))
    .sort(byLongestUnchecked);

  return { due, selected: Number.isFinite(limit) ? due.slice(0, limit) : due };
};

/**
 * Longest-unchecked first, with never-checked before every date and `_id`
 * deciding the rest. `sort` is stable in Node, but the array it is handed came
 * out of a cursor, so the tie-break is what makes the order reproducible
 * rather than the stability.
 */
const byLongestUnchecked = (a, b) =>
  (lastCheckedAt(a) ?? -Infinity) - (lastCheckedAt(b) ?? -Infinity) ||
  String(a?._id).localeCompare(String(b?._id));

/**
 * How far behind a collection is, as four numbers the audit can print and a
 * scheduled run can be judged by.
 *
 * This exists because of #303's lesson rather than because a count is
 * interesting. A crawl that stops — a revoked key, a workflow GitHub disabled
 * after sixty days of repository quiet, a cron nobody notices was never
 * enabled — stops *silently*, and the only trace it leaves is here: `dueNow`
 * stops falling and `oldestCheckedAt` stops moving. Putting it in
 * scripts/audit_database.js, which is read-only and needs no API key, means
 * the question "is the refresh still running" is answered in the same place as
 * every other question about the database's health, by a command anyone can
 * run.
 *
 * @type {(works: any[], options?: { maxAgeMs?: number, now?: number }) => object}
 */
const summarizeFreshness = (
  works,
  { maxAgeMs = DEFAULT_MAX_AGE_DAYS * DAY_MS, now = Date.now() } = {}
) => {
  const list = Array.isArray(works) ? works : [];
  const checked = list.map(lastCheckedAt).filter((at) => at !== undefined);

  return {
    works: list.length,
    neverChecked: list.length - checked.length,
    dueNow: list.filter((work) => isStale(work, { maxAgeMs, now })).length,
    oldestCheckedAt: checked.length === 0 ? null : Math.min(...checked),
    newestCheckedAt: checked.length === 0 ? null : Math.max(...checked),
  };
};

/**
 * How many runs of `--limit=N` are left before a collection is caught up, so a
 * schedule can be chosen with the number in front of it rather than guessed.
 * Ceiling division, and `null` for an unlimited run, which finishes in one.
 */
const runsRemaining = (dueCount, limit) =>
  Number.isFinite(limit) && limit > 0 ? Math.ceil(dueCount / limit) : null;

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  DAY_MS,
  lastCheckedAt,
  isDue,
  isStale,
  selectForRefresh,
  summarizeFreshness,
  runsRemaining,
};
