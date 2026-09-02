const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  hasGaps,
  mergeWork,
  mergeApiRefs,
  mergeExternalUrls,
  corruptFieldsOf,
  isMissingPlaytimeLink,
  completeness,
} = require("./work_metadata_merge");

const games = COLLECTIONS.find((c) => c.type === "games");
const books = COLLECTIONS.find((c) => c.type === "books");

/** What the games adapter returns now: IGDB for the metadata and the playtime. */
const freshGame = {
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  releaseYear: 2017,
  duration: 750,
  durationSource: "igdb",
  imageUrl: "https://img",
  genres: ["Platform"],
  platforms: ["PC"],
  studios: ["Team Cherry"],
  publishers: ["Team Cherry"],
  apiRefs: ["igdb__14593"],
  externalUrls: [{ name: "igdb", url: "https://igdb.com/hk" }],
};

/**
 * A game cached back when HowLongToBeat still answered: its playtime and its
 * link, and little else. 775 games look like this.
 */
const staleGame = {
  _id: "a",
  entryType: "Game",
  englishTranslatedTitle: "Hollow Knight",
  duration: 1500,
  apiRefs: ["igdb__14593", "hltb__26286"],
  externalUrls: [
    { name: "hltb", url: "https://howlongtobeat.com/game?id=26286" },
  ],
};

const backfilled = () => ({
  ...staleGame,
  ...mergeWork(games, staleGame, freshGame).updates,
});

test("a HowLongToBeat playtime is kept, and IGDB's is not written over it", () => {
  // The requirement this whole change hangs on. IGDB says 750 minutes, from a
  // median of three submissions; the stored 1500 came from far more.
  const { updates, notes } = mergeWork(games, staleGame, freshGame);

  assert.equal("duration" in updates, false);
  assert.equal("durationSource" in updates, false);
  assert.match(notes.join("\n"), /kept the stored duration 1500/);
});

test("provenance is never written next to a duration it didn't produce", () => {
  // A `durationSource: "igdb"` on a HowLongToBeat playtime would make the
  // record less trustworthy than having no record at all.
  assert.equal(backfilled().durationSource, undefined);
  assert.equal(backfilled().duration, 1500);
});

test("a playtime IGDB does fill in is tagged with where it came from", () => {
  const empty = { ...staleGame, duration: undefined };
  const { updates } = mergeWork(games, empty, freshGame);

  assert.equal(updates.duration, 750);
  assert.equal(updates.durationSource, "igdb");
});

test("IGDB may refresh a playtime it wrote itself", () => {
  const own = { ...staleGame, duration: 700, durationSource: "igdb" };
  const { updates } = mergeWork(games, own, freshGame);

  assert.equal(updates.duration, 750);
  assert.equal(updates.durationSource, "igdb");
});

test("a film's runtime still refreshes, having never carried a source", () => {
  const films = COLLECTIONS.find((c) => c.type === "films");
  const { updates } = mergeWork(
    films,
    { entryType: "Film", duration: 140, apiRefs: ["tmdb__1"] },
    { entryType: "Film", duration: 148, apiRefs: ["tmdb__1"] }
  );

  assert.equal(updates.duration, 148);
  assert.equal("durationSource" in updates, false);
});

test("backfilling keeps the HowLongToBeat ref and link the game already has", () => {
  // The adapter no longer reports them — the API is gone — but the pages
  // still exist and 775 games link to them.
  const refreshed = backfilled();

  assert.deepEqual(refreshed.apiRefs, ["igdb__14593", "hltb__26286"]);
  assert.deepEqual(refreshed.externalUrls, [
    { name: "hltb", url: "https://howlongtobeat.com/game?id=26286" },
    { name: "igdb", url: "https://igdb.com/hk" },
  ]);
  assert.deepEqual(refreshed.genres, ["Platform"]);
});

test("a HowLongToBeat playtime with no stored link is searched for by title", () => {
  // #201 gave the column a HowLongToBeat search to fall back on, so the 210
  // games with a playtime and no ref to build a page url from are linked.
  const noStoredLink = { ...staleGame, apiRefs: ["igdb__14593"], externalUrls: [] };

  assert.equal(isMissingPlaytimeLink(games, noStoredLink), false);
  assert.equal(
    isMissingPlaytimeLink(games, {
      ...noStoredLink,
      englishTranslatedTitle: undefined,
      originalTitle: "空の軌跡",
    }),
    false
  );
});

test("a playtime with nothing to link to is reported but not chased", () => {
  // Nothing stored and no title to search on: the column renders this one as
  // bare text. No API can add a HowLongToBeat link any more, so re-running
  // the adapter at it forever would only burn the call.
  const unlinkable = {
    ...staleGame,
    englishTranslatedTitle: undefined,
    apiRefs: ["igdb__14593"],
    externalUrls: [],
  };

  assert.equal(isMissingPlaytimeLink(games, unlinkable), true);
  assert.equal(isMissingPlaytimeLink(games, { ...unlinkable, originalTitle: "" }), true);
  assert.equal(hasGaps(games, { ...backfilled(), externalUrls: [] }), false);
});

test("an IGDB playtime is linked by its IGDB url, not a HowLongToBeat one", () => {
  const igdbSourced = { ...staleGame, duration: 750, durationSource: "igdb" };

  // A title is no help here: case 1 has no search to fall back on, so an IGDB
  // duration with no igdb url is the one thing still worth reporting.
  assert.equal(isMissingPlaytimeLink(games, igdbSourced), true);
  assert.equal(
    isMissingPlaytimeLink(games, {
      ...igdbSourced,
      externalUrls: [{ name: "igdb", url: "https://igdb.com/hk" }],
    }),
    false
  );
});

test("a game with no playtime has no playtime link to miss", () => {
  assert.equal(isMissingPlaytimeLink(games, { ...staleGame, duration: null }), false);
  assert.equal(isMissingPlaytimeLink(books, { duration: 412 }), false);
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
  assert.match(notes.join("\n"), /Hollow Knight.*Silksong/);
});

test("legacy object-shaped apiRefs are normalised to flat strings", () => {
  const legacy = { ...staleGame, apiRefs: [{ name: "igdb", ref: "14593" }] };

  assert.equal(hasGaps(games, legacy), true);
  assert.deepEqual(mergeWork(games, legacy, freshGame).updates.apiRefs, [
    "igdb__14593",
  ]);
});

test("a ref the API stops reporting still survives a refresh", () => {
  assert.deepEqual(mergeWork(games, backfilled(), freshGame).updates, {});
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

test("placeholder refs are not treated as identifiers", () => {
  const { parseApiRef, findApiRef } = require("./work_collections");

  for (const bad of [
    "hltb__N/A",
    "undefined__undefined",
    "igdb__",
    "tmdb__null",
    "igdb__0",
    "ISBN__NaN",
  ]) {
    assert.equal(parseApiRef(bad), undefined, `${bad} should not parse`);
  }

  assert.deepEqual(parseApiRef("igdb__14593"), {
    name: "igdb",
    ref: "14593",
    flat: true,
  });
  assert.equal(findApiRef(["hltb__N/A", "igdb__1"], "hltb"), undefined);
});

test("a placeholder ref is dropped rather than carried forward", () => {
  const work = { ...staleGame, apiRefs: ["igdb__14593", "hltb__N/A"] };

  assert.deepEqual(mergeWork(games, work, freshGame).updates.apiRefs, [
    "igdb__14593",
  ]);
});

test("a work whose only ref is a placeholder cannot be refreshed", () => {
  const { findApiRef } = require("./work_collections");
  const work = { _id: "x", entryType: "Game", apiRefs: ["hltb__N/A"] };

  assert.equal(findApiRef(work.apiRefs, games.retrievePrefix), undefined);
});
