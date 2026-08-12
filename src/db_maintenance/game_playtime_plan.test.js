const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  hasStoredPlaytime,
  igdbGameId,
  gameIdsToLookUp,
  planPlaytimeBackfill,
  summarize,
} = require("./game_playtime_plan");
const {
  indexTimesByGameId,
} = require("../api/utils/external_api_adapters/games/time_to_beat");

const times = indexTimesByGameId([
  { game_id: 14593, hastily: 45000, normally: 102780, count: 13 },
  { game_id: 3042, hastily: 3600, normally: 7200, count: 1 },
]);

const game = (overrides) => ({
  _id: "a",
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  apiRefs: ["igdb__14593"],
  ...overrides,
});

test("a game with no playtime gets one, tagged with where it came from", () => {
  const plan = planPlaytimeBackfill([game()], times);

  assert.equal(plan.fill.length, 1);
  assert.deepEqual(plan.fill[0].updates, { duration: 1713, durationSource: "igdb" });
  assert.equal(plan.fill[0].submissions, 13);
});

test("a game that already has a playtime is never touched", () => {
  // The whole point. IGDB says 1713 minutes; the stored 1500 stays.
  const plan = planPlaytimeBackfill([game({ duration: 1500 })], times);

  assert.deepEqual(plan.fill, []);
  assert.equal(plan.hasDuration.length, 1);
});

test("a stored zero is not a playtime, and is filled like a missing one", () => {
  // 23 games hold `duration: 0`, which the playtime column already renders as
  // `-`. Writing a real number over it takes nothing away from anyone.
  for (const duration of [0, null, undefined, -30, "600"]) {
    assert.equal(hasStoredPlaytime(game({ duration })), false, String(duration));
    assert.equal(
      planPlaytimeBackfill([game({ duration })], times).fill.length,
      1,
      String(duration)
    );
  }

  assert.equal(hasStoredPlaytime(game({ duration: 1 })), true);
});

test("a game IGDB has no time for is reported, not filled", () => {
  const plan = planPlaytimeBackfill([game({ apiRefs: ["igdb__999"] })], times);

  assert.deepEqual(plan.fill, []);
  assert.equal(plan.noIgdbTime.length, 1);
  assert.equal(plan.noIgdbTime[0].gameId, 999);
});

test("a game with no usable igdb ref is reported, not filled", () => {
  for (const apiRefs of [[], ["hltb__26286"], ["igdb__"], ["igdb__N/A"], undefined]) {
    const plan = planPlaytimeBackfill([game({ apiRefs })], times);
    assert.deepEqual(plan.fill, [], `apiRefs ${JSON.stringify(apiRefs)}`);
    assert.equal(plan.noIgdbRef.length, 1, `apiRefs ${JSON.stringify(apiRefs)}`);
  }
});

test("an igdb ref still stored as an object is understood", () => {
  assert.equal(igdbGameId({ apiRefs: [{ name: "igdb", ref: "14593" }] }), 14593);
});

test("a placeholder ref is never read as a game id", () => {
  // 27 games carry `hltb__N/A`; an id of "N/A" would collide every one of
  // them onto whatever game IGDB happens to return first.
  assert.equal(igdbGameId({ apiRefs: ["igdb__N/A"] }), undefined);
  assert.equal(igdbGameId({ apiRefs: ["hltb__N/A"] }), undefined);
  assert.equal(igdbGameId({}), undefined);
});

test("only games that need a playtime are looked up, and each id only once", () => {
  const ids = gameIdsToLookUp([
    game(),
    game({ _id: "b" }),
    game({ _id: "c", apiRefs: ["igdb__3042"] }),
    game({ _id: "d", apiRefs: ["igdb__777"], duration: 600 }),
    game({ _id: "e", apiRefs: ["hltb__1"] }),
  ]);

  assert.deepEqual(ids.sort((a, b) => a - b), [3042, 14593]);
});

test("two documents under one igdb id both get that game's playtime", () => {
  // Sharing an apiRef does not make them the same work, and this doesn't
  // treat them as one: each keeps its own document, and both are told what
  // IGDB says about game 14593.
  const plan = planPlaytimeBackfill([game(), game({ _id: "b" })], times);

  assert.equal(plan.fill.length, 2);
  assert.deepEqual(
    plan.fill.map((f) => f.id),
    ["a", "b"]
  );
});

test("the summary says how many games have a playtime before and after", () => {
  const works = [
    game(),
    game({ _id: "b", duration: 1500 }),
    game({ _id: "c", apiRefs: ["igdb__999"] }),
    game({ _id: "d", apiRefs: [] }),
  ];

  assert.deepEqual(summarize(works, planPlaytimeBackfill(works, times)), {
    games: 4,
    withPlaytimeBefore: 1,
    withPlaytimeAfter: 2,
    withoutPlaytimeBefore: 3,
    withoutPlaytimeAfter: 2,
    filled: 1,
    overwritten: 0,
    unfillableNoIgdbRef: 1,
    unfillableNoIgdbTime: 1,
  });
});

test("nothing to do is not an error", () => {
  const plan = planPlaytimeBackfill([], new Map());
  assert.deepEqual(plan.fill, []);
  assert.equal(summarize([], plan).games, 0);
  assert.deepEqual(gameIdsToLookUp(undefined), []);
});
