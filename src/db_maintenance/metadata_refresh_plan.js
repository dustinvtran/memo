/**
 * @file Which works a refresh run spends its API calls on, in what order,
 * which of its outcomes let a work leave the queue, and how far behind the
 * library as a whole has fallen.
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
const { notFound } = require("../api/utils/errors");

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

/**
 * The class `../api/utils/errors.js` gives a 404, asked of the module the
 * adapters build their errors with rather than copied here as a string. A
 * literal would be a second spelling of `NotFound` that nothing would fail if
 * somebody renamed the first.
 */
const NOT_FOUND = notFound().error;

/**
 * Whether a failed retrieve was an answer about this work rather than weather.
 *
 * The third of the three outcomes that have to advance the queue, and the only
 * one of them that needs a judgement to tell it from an outcome that must not.
 * The other two are beside their `touch()` calls in
 * scripts/backfill_work_metadata.js: a refusal (#333) and a work carrying no
 * id at all (#343). This one is here because it reads an error class rather
 * than a document, and because reading it wrong is silent either way.
 *
 * `tmdb_adapter.js`, `games/igdb.js` and `books/google.js` each map a 404 to
 * `errors.notFound()` and everything else — a 429, a 503, a timeout, a dropped
 * connection, a 401 — to `errors.internal()` or `errors.unauthorized()`,
 * deliberately and with a comment saying why. IGDB and Google Books go further
 * and *manufacture* a 404, because an id neither of them holds comes back as
 * an empty array rather than as a status. So the distinction already exists in
 * the error class and this only has to read it.
 *
 * Which way round the doubt falls is the whole of it. A 404 read as weather is
 * #352: fourteen works whose ids their API no longer holds, re-fetched every
 * night for ever, each spending a real call to be told the same thing, at the
 * head of a queue sorted longest-unchecked first. A 429 read as a fact about
 * the work would be far worse — it would stamp the whole slice on the night a
 * quota ran out and record a spent budget as six months of freshness — which
 * is why this names the one class that may stamp instead of listing the ones
 * that may not. A class nobody thought of is weather, and weather is retried.
 *
 * @type {(error: unknown) => boolean}
 */
const isPermanentFailure = (error) => error?.error === NOT_FOUND;

/**
 * A run's report reduced to the two numbers that say whether the APIs were
 * working at all, and the verdict `reportProgress` in
 * scripts/backfill_work_metadata.js draws from them. That function's comment
 * is where the reasoning lives and is worth reading before moving a bucket
 * from one total to the other; this is only the arithmetic, here so that the
 * suite can reach it.
 *
 * Four buckets are answers: a work the API described, a work it described as
 * something else (a refusal), a work it confirmed was already current, and a
 * work it says it no longer holds. All four mean a working API and all four
 * advance the queue.
 *
 * `unrefreshable` is in neither total, on purpose, and that is the half #352
 * changed. A work with no id costs no call, so counting it as answered would
 * let a slice made of nothing else report a healthy API, and counting it as
 * failed would turn an ordinary run red. It used to be `processed` that
 * guarded this, which is every work in the slice including those — so a slice
 * of 150 works with no ids and no calls at all reported that "every one of the
 * 0 API calls this run made failed". A run that made no calls is not stalled;
 * it has run out of things worth asking.
 *
 * @type {(report: object) => { answered: number, failed: number, stalled: boolean }}
 */
const summarizeProgress = (report) => {
  const totals = Object.values(report ?? {}).reduce(
    (sum, result) => ({
      answered:
        sum.answered +
        (result?.changes?.length ?? 0) +
        (result?.refusals?.length ?? 0) +
        (result?.deadRefs?.length ?? 0) +
        (result?.unchanged ?? 0),
      failed: sum.failed + (result?.failures?.length ?? 0),
    }),
    { answered: 0, failed: 0 }
  );

  return { ...totals, stalled: totals.failed > 0 && totals.answered === 0 };
};

/**
 * Every work this run could not refresh because its stored title disagreed
 * with the one its id answers with.
 *
 * A refusal is not a failure — the API answered, the ref is fine, and the
 * #290 title guard declined to merge. But it is not a success either, and
 * until now it was neither: the run printed a line and exited 0, so a work
 * could be refused every night for years and nothing said so. #381 found 93
 * of them, and `docs/works_and_entries.md` is why they are all one bug.
 *
 * Counted rather than judged here, so the caller decides whether a refusal is
 * a condition to fail on.
 * @type {(report: object) => Array<{ collection: string, refused: string, title?: string }>}
 */
const frozenWorks = (report) =>
  Object.entries(report ?? {}).flatMap(([collection, result]) =>
    (result?.refusals ?? []).map((refusal) => ({ collection, ...refusal }))
  );

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  frozenWorks,
  DAY_MS,
  lastCheckedAt,
  isDue,
  isStale,
  selectForRefresh,
  summarizeFreshness,
  runsRemaining,
  isPermanentFailure,
  summarizeProgress,
};
