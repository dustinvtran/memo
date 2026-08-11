const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  hasGaps,
  mergeWork,
  mergeApiRefs,
  mergeExternalUrls,
  corruptFieldsOf,
  completeness,
} = require("./work_metadata_merge");

const games = COLLECTIONS.find((c) => c.type === "games");
const books = COLLECTIONS.find((c) => c.type === "books");

const freshGame = {
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  releaseYear: 2017,
  duration: 1500,
  imageUrl: "https://img",
  genres: ["Platform"],
  platforms: ["PC"],
  studios: ["Team Cherry"],
  publishers: ["Team Cherry"],
  apiRefs: ["igdb__14593", "hltb__26286"],
  externalUrls: [
    { name: "igdb", url: "https://igdb.com/hk" },
    { name: "hltb", url: "https://howlongtobeat.com/game?id=26286" },
  ],
};

/** What mongodb_add_missing_durations.js left behind: a duration, but no
 * hltb ref and no HowLongToBeat link. */
const staleGame = {
  _id: "a",
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  duration: 1500,
  apiRefs: ["igdb__14593"],
  externalUrls: [{ name: "igdb", url: "https://igdb.com/hk" }],
};

const backfilled = () => ({
  ...staleGame,
  ...mergeWork(games, staleGame, freshGame).updates,
});

test("a game with a duration but no HowLongToBeat link is flagged", () => {
  assert.equal(hasGaps(games, staleGame), true);
});

test("backfilling adds the hltb ref and url without losing the igdb ones", () => {
  const { updates, notes } = mergeWork(games, staleGame, freshGame);

  assert.deepEqual(updates.apiRefs, ["igdb__14593", "hltb__26286"]);
  assert.deepEqual(updates.externalUrls, [
    { name: "igdb", url: "https://igdb.com/hk" },
    { name: "hltb", url: "https://howlongtobeat.com/game?id=26286" },
  ]);
  assert.deepEqual(updates.genres, ["Platform"]);
  assert.equal("duration" in updates, false, "unchanged values aren't rewritten");
  assert.deepEqual(notes, []);
});

test("a backfilled game is left alone on the next pass", () => {
  const work = backfilled();
  assert.deepEqual(mergeWork(games, work, freshGame).updates, {});
  assert.equal(hasGaps(games, work), false);
});

test("empty API values never clear stored data", () => {
  const work = { ...backfilled(), imageUrl: "https://kept" };
  const sparse = {
    ...freshGame,
    genres: [],
    imageUrl: "",
    studios: undefined,
    publishers: null,
  };

  assert.deepEqual(mergeWork(games, work, sparse).updates, {});
});

test("fields absent from the API response are left untouched", () => {
  const work = { ...backfilled(), notes: "hand written" };
  const updates = mergeWork(games, work, { entryType: "Game" }).updates;

  assert.deepEqual(updates, {});
});

test("missingOnly fills gaps but refuses to overwrite usable values", () => {
  const work = { ...backfilled(), genres: ["Metroidvania"], imageUrl: "" };
  const updates = mergeWork(games, work, freshGame, { missingOnly: true }).updates;

  assert.deepEqual(updates, { imageUrl: "https://img" });
});

test("a changed title is applied but called out for review", () => {
  const { updates, notes } = mergeWork(games, backfilled(), {
    ...freshGame,
    englishTranslatedTitle: "Silksong",
  });

  assert.equal(updates.englishTranslatedTitle, "Silksong");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Hollow Knight.*Silksong/);
});

test("legacy object-shaped apiRefs are normalised to flat strings", () => {
  const legacy = { ...staleGame, apiRefs: [{ name: "igdb", ref: "14593" }] };

  assert.equal(hasGaps(games, legacy), true);
  assert.deepEqual(mergeWork(games, legacy, freshGame).updates.apiRefs, [
    "igdb__14593",
    "hltb__26286",
  ]);
});

test("a ref the API stops reporting still survives a refresh", () => {
  const work = backfilled();
  const withoutHltb = {
    ...freshGame,
    apiRefs: ["igdb__14593"],
    externalUrls: [{ name: "igdb", url: "https://igdb.com/hk" }],
  };

  assert.deepEqual(mergeWork(games, work, withoutHltb).updates, {});
});

test("mergeApiRefs prefers fresh refs, or existing ones with missingOnly", () => {
  assert.deepEqual(mergeApiRefs(["hltb__1"], ["hltb__2"]), ["hltb__2"]);
  assert.deepEqual(mergeApiRefs(["hltb__1"], ["hltb__2"], { missingOnly: true }), [
    "hltb__1",
  ]);
  assert.deepEqual(mergeApiRefs(undefined, ["igdb__3"]), ["igdb__3"]);
  assert.deepEqual(mergeApiRefs(["nonsense"], ["igdb__3"]), ["igdb__3"]);
});

test("mergeExternalUrls drops malformed links and keeps one per name", () => {
  assert.deepEqual(
    mergeExternalUrls(
      [{ name: "igdb", url: "https://old" }, { url: "https://nameless" }],
      [{ name: "igdb", url: "https://new" }, { name: "hltb", url: "https://hltb" }]
    ),
    [
      { name: "igdb", url: "https://new" },
      { name: "hltb", url: "https://hltb" },
    ]
  );
});

test("the Promise mongodb_add_missing_book_publishers.js stored is repaired", () => {
  // An un-awaited Promise lands in Mongo as {}.
  const corruptBook = {
    _id: "b",
    entryType: "Book",
    englishTranslatedTitle: "Dune",
    imageUrl: "https://img",
    releaseYear: 1965,
    duration: 412,
    genres: ["Sci-Fi"],
    authors: ["Frank Herbert"],
    publishers: {},
    apiRefs: ["ISBN__9780441013593"],
  };

  assert.deepEqual(corruptFieldsOf(books, corruptBook), ["publishers"]);
  assert.equal(hasGaps(books, corruptBook), true);

  const updates = mergeWork(
    books,
    corruptBook,
    {
      entryType: "Book",
      publishers: ["Ace Books"],
      apiRefs: ["ISBN__9780441013593"],
    },
    { missingOnly: true }
  ).updates;

  assert.deepEqual(updates, { publishers: ["Ace Books"] });
});

test("an array of arrays counts as corrupt, not as data", () => {
  assert.deepEqual(
    corruptFieldsOf(books, {
      entryType: "Book",
      apiRefs: [],
      publishers: [["Ace Books"]],
    }),
    ["publishers"]
  );
});

test("a wrong entryType is repaired", () => {
  const updates = mergeWork(
    games,
    { ...backfilled(), entryType: "Film" },
    freshGame
  ).updates;

  assert.deepEqual(updates, { entryType: "Game" });
});

test("completeness counts usable expected fields", () => {
  assert.equal(completeness(games, {}), 0);
  assert.ok(completeness(games, backfilled()) > completeness(games, staleGame));
});
