const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  DAY_MS,
  lastCheckedAt,
  isDue,
  isStale,
  selectForRefresh,
  summarizeFreshness,
  runsRemaining,
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
