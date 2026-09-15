const { test } = require("node:test");
const assert = require("node:assert/strict");

const errors = require("../api/utils/errors");
const { COLLECTIONS } = require("./work_collections");
const {
  DAY_MS,
  lastCheckedAt,
  isDue,
  isStale,
  selectForRefresh,
  summarizeFreshness,
  runsRemaining,
  isPermanentFailure,
  summarizeProgress,
} = require("./metadata_refresh_plan");

const games = COLLECTIONS.find((c) => c.type === "games");

const NOW = Date.UTC(2026, 8, 14);
const daysAgo = (n) => NOW - n * DAY_MS;

/** A game with nothing missing, so only its age can make it due. */
const complete = (overrides) => ({
  _id: "a",
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  imageUrl: "https://img",
  releaseYear: 2017,
  duration: 750,
  genres: ["Platform"],
  platforms: ["PC"],
  studios: ["Team Cherry"],
  publishers: ["Team Cherry"],
  apiRefs: ["igdb__14593"],
  externalUrls: [{ name: "igdb", url: "https://igdb.com/hk" }],
  ...overrides,
});

test("a complete work is due for its age and never for its gaps", () => {
  // The whole of #333 in two assertions. Every run applied so far has been
  // `--missing-only`, and a work whose release date was TBD when it was added
  // is complete — the placeholder year is a value, not a gap — so that mode
  // cannot reach it however often it runs.
  const stale = complete({ metadataUpdatedDate: daysAgo(400) });

  assert.equal(isDue(games, stale, { missingOnly: true, now: NOW }), false);
  assert.equal(isDue(games, stale, { now: NOW }), true);
});

test("the age window is the default 180 days unless it is given", () => {
  const work = complete({ metadataUpdatedDate: daysAgo(200) });

  assert.equal(isDue(games, work, { now: NOW }), true);
  assert.equal(isDue(games, work, { now: NOW, maxAgeMs: 365 * DAY_MS }), false);
  // --force ignores the window, which is what a one-off repair run wants.
  assert.equal(
    isDue(games, work, { now: NOW, maxAgeMs: 365 * DAY_MS, force: true }),
    true
  );
});

test("a work that has never been checked is due, and sorts before every date", () => {
  // As of the 2026-09-03 run this is all 1,560 films, all 510 tv shows and all
  // 696 books: the first crawl is the whole library, in this bucket.
  const never = complete({ _id: "never" });

  assert.equal(lastCheckedAt(never), undefined);
  assert.equal(isStale(never, { now: NOW }), true);

  const { selected } = selectForRefresh(
    games,
    [complete({ _id: "old", metadataUpdatedDate: daysAgo(400) }), never],
    { now: NOW }
  );

  assert.deepEqual(
    selected.map((w) => w._id),
    ["never", "old"]
  );
});

test("a non-numeric stamp is no stamp at all", () => {
  // A Date, or the string a hand-written `updateOne` would leave.
  for (const bad of [new Date(NOW), String(NOW), null]) {
    assert.equal(lastCheckedAt({ metadataUpdatedDate: bad }), undefined);
    assert.equal(isStale({ metadataUpdatedDate: bad }, { now: NOW }), true);
  }
});

test("the queue is longest-unchecked first, and the slice is its head", () => {
  // The reason the order matters: with a slice of two per run, an arbitrary
  // order can re-read one work twice while another waits months. This is what
  // makes a crawl resumable.
  const works = [
    complete({ _id: "b", metadataUpdatedDate: daysAgo(200) }),
    complete({ _id: "c", metadataUpdatedDate: daysAgo(900) }),
    complete({ _id: "d", metadataUpdatedDate: daysAgo(10) }),
    complete({ _id: "e", metadataUpdatedDate: daysAgo(400) }),
  ];

  const { due, selected } = selectForRefresh(games, works, {
    now: NOW,
    limit: 2,
  });

  // `d` was read ten days ago and is not due at all.
  assert.deepEqual(
    due.map((w) => w._id),
    ["c", "e", "b"]
  );
  assert.deepEqual(
    selected.map((w) => w._id),
    ["c", "e"]
  );
});

test("works checked at the same moment are ordered by _id, not by the server", () => {
  // Two runs over the same data have to pick the same slice, or a crawl's
  // progress is not something anyone can predict or resume.
  const at = daysAgo(300);
  const works = ["c", "a", "b"].map((id) =>
    complete({ _id: id, metadataUpdatedDate: at })
  );

  assert.deepEqual(
    selectForRefresh(games, works, { now: NOW }).due.map((w) => w._id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    selectForRefresh(games, [...works].reverse(), { now: NOW }).due.map(
      (w) => w._id
    ),
    ["a", "b", "c"]
  );
});

test("no limit means the whole queue", () => {
  const works = [complete({ _id: "a" }), complete({ _id: "b" })];
  const { selected } = selectForRefresh(games, works, { now: NOW });

  assert.equal(selected.length, 2);
  assert.equal(runsRemaining(2, Infinity), null);
});

test("runsRemaining says how many slices catching up takes", () => {
  assert.equal(runsRemaining(3900, 200), 20);
  assert.equal(runsRemaining(201, 200), 2);
  assert.equal(runsRemaining(0, 200), 0);
});

test("summarizeFreshness is the gauge a stalled crawl shows up in", () => {
  const summary = summarizeFreshness(
    [
      complete({ _id: "a" }),
      complete({ _id: "b" }),
      complete({ _id: "c", metadataUpdatedDate: daysAgo(400) }),
      complete({ _id: "d", metadataUpdatedDate: daysAgo(10) }),
    ],
    { now: NOW }
  );

  assert.deepEqual(summary, {
    works: 4,
    neverChecked: 2,
    dueNow: 3,
    oldestCheckedAt: daysAgo(400),
    newestCheckedAt: daysAgo(10),
  });
});

test("a collection nothing has ever been checked in reports no dates", () => {
  assert.deepEqual(summarizeFreshness([complete({})], { now: NOW }), {
    works: 1,
    neverChecked: 1,
    dueNow: 1,
    oldestCheckedAt: null,
    newestCheckedAt: null,
  });

  assert.deepEqual(summarizeFreshness([], { now: NOW }), {
    works: 0,
    neverChecked: 0,
    dueNow: 0,
    oldestCheckedAt: null,
    newestCheckedAt: null,
  });
});

test("--missing-only still picks up a work with a gap, however recently read", () => {
  // Which is what keeps a refused work reachable now that the backfill stamps
  // one: the date decides an age-based run and nothing else.
  const gappy = complete({
    _id: "g",
    releaseYear: undefined,
    metadataUpdatedDate: NOW,
  });

  assert.equal(isDue(games, gappy, { missingOnly: true, now: NOW }), true);
  assert.equal(isDue(games, gappy, { now: NOW }), false);
});


/**
 * #352. The queue is ordered longest-unchecked first and an unstamped work
 * has no date at all, so anything the backfill leaves unstamped sits at the
 * head of it for ever. On the first autonomous run that was the whole books
 * slice — `89 refused + 4 failed + 57 with no ISBN = 150` — and the run
 * updated nothing while printing four green lines.
 *
 * The three tests below are the three outcomes the script has to get right,
 * and they are here rather than beside the script because the script is the
 * half with a database and four API keys in it.
 */
test("a work with no ref advances the queue once it has been stamped", () => {
  // The stamp itself is `touch()` in scripts/backfill_work_metadata.js; what
  // this pins is that a stamped work stops being due at all, so the slot goes
  // to whatever was behind it, and that an unstamped one takes that slot back
  // on every run for ever. 191 works carry no id (#343), so before #352 those
  // 191 were the permanent head of the queue.
  const noRef = complete({ _id: "n", apiRefs: [], metadataUpdatedDate: NOW });
  const waiting = complete({ _id: "w", metadataUpdatedDate: daysAgo(400) });

  const { selected } = selectForRefresh(games, [noRef, waiting], {
    now: NOW,
    limit: 1,
  });

  assert.deepEqual(
    selected.map((w) => w._id),
    ["w"]
  );

  // And unstamped, which is what it did before, it takes the slot instead —
  // every night, since nothing about it will change until a human gives it an
  // id.
  const before = selectForRefresh(
    games,
    [complete({ _id: "n", apiRefs: [] }), waiting],
    { now: NOW, limit: 1 }
  );
  assert.deepEqual(
    before.selected.map((w) => w._id),
    ["n"]
  );
});

test("a 404 is an answer about the work and a 429 is weather", () => {
  // The adapters already draw this line: tmdb_adapter.js, games/igdb.js and
  // books/google.js each map a 404 to `errors.notFound()` and everything else
  // to `errors.internal()`. This reads the class rather than a status, so the
  // two sides of it stay one decision made in one place.
  const notFound = errors.notFound(undefined, "no such book");
  assert.equal(isPermanentFailure(notFound), true);
  assert.equal(isPermanentFailure(errors.internal("429 Too Many")), false);
  assert.equal(isPermanentFailure(errors.internal("tmdb timed out")), false);
  assert.equal(isPermanentFailure(errors.unauthorized("401")), false);
  assert.equal(isPermanentFailure(errors.db("connection reset")), false);

  // A class nobody thought of is weather, and weather is retried. The cost of
  // being wrong is not symmetric: a 404 retried for ever wastes one call a
  // night, and a 429 taken for a fact about the work records a spent quota as
  // six months of freshness.
  assert.equal(isPermanentFailure({ error: "SomethingNew" }), false);
  assert.equal(isPermanentFailure("no such book"), false);
  assert.equal(isPermanentFailure(undefined), false);
});

test("an all-failed run reports no progress, and a 404 is not a failure", () => {
  // `reportProgress` in scripts/backfill_work_metadata.js is the only thing a
  // scheduled crawl can say about itself, and this is the case it exists for:
  // a revoked key or a spent quota looks identical to a healthy run in every
  // count but this one. #352 must not have weakened it.
  assert.deepEqual(
    summarizeProgress({
      films: {
        failures: [{}, {}, {}],
        changes: [],
        refusals: [],
        unchanged: 0,
      },
      books: { failures: [{}], changes: [], refusals: [], unchanged: 0 },
    }),
    { answered: 0, failed: 4, stalled: true }
  );

  // One answer anywhere is a working API, whichever of the four kinds it is.
  for (const answer of [
    { changes: [{}] },
    { refusals: [{}] },
    { deadRefs: [{}] },
    { unchanged: 1 },
  ]) {
    const totals = summarizeProgress({
      films: { failures: [{}, {}] },
      books: answer,
    });
    assert.equal(totals.stalled, false, `${Object.keys(answer)[0]} is an answer`);
  }
});

test("a run that made no calls at all is not a stalled run", () => {
  // The half of the guard #352 changed. A work with no ref costs no call, so
  // a slice made of nothing else neither answers nor fails — and the old test,
  // over works processed rather than calls made, announced that every one of
  // its 0 API calls had failed.
  assert.deepEqual(
    summarizeProgress({
      books: { works: 650, due: 224, processed: 150, asked: 0, failures: [] },
    }),
    { answered: 0, failed: 0, stalled: false }
  );

  assert.equal(summarizeProgress({}).stalled, false);
  assert.equal(summarizeProgress(undefined).stalled, false);
});

test("each collection carries its own nightly slice size", () => {
  // The other half of #352: films, tv and games each cleared their whole due
  // list inside a slice of 150 while books ran out at 150 with 74 waiting, and
  // books is the only one of the four whose API caps a day rather than a rate.
  // The numbers live beside the pauses in ./work_collections.js, and what is
  // pinned here is that all four have one.
  for (const collection of COLLECTIONS) {
    assert.ok(
      Number.isInteger(collection.defaultLimit) && collection.defaultLimit > 0,
      `${collection.type} has no defaultLimit`
    );
  }

  // And that `selectForRefresh` does not read them. It answers with the whole
  // queue when it is given no limit, which is what
  // scripts/propose_book_refs.js asks it for, so the fallback to the
  // collection's own number is resolved in the backfill script instead —
  // the one place where a slice is what is wanted.
  const works = ["a", "b", "c"].map((id) => complete({ _id: id }));
  assert.equal(selectForRefresh(games, works, { now: NOW }).selected.length, 3);
  assert.equal(
    selectForRefresh(games, works, { now: NOW, limit: 2 }).selected.length,
    2
  );
});
