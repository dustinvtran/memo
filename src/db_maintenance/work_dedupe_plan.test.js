const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const { planDedupe, groupKey } = require("./work_dedupe_plan");

const films = COLLECTIONS.find((c) => c.type === "films");
const books = COLLECTIONS.find((c) => c.type === "books");

const film = (id, extra) => ({
  _id: id,
  entryType: "Film",
  englishTranslatedTitle: "Stalker",
  apiRefs: ["tmdb__1398"],
  ...extra,
});

test("works that share no apiRef are left alone", () => {
  const works = [film("a"), film("b", { apiRefs: ["tmdb__999"] })];

  assert.deepEqual(planDedupe(films, works, []), []);
});

test("a work with no apiRef is never grouped", () => {
  const works = [film("a", { apiRefs: [] }), film("b", { apiRefs: undefined })];

  assert.deepEqual(planDedupe(films, works, []), []);
});

test("the most complete duplicate survives and absorbs the rest", () => {
  const sparse = film("a", { imageUrl: undefined, genres: [] });
  const rich = film("b", {
    imageUrl: "https://img",
    genres: ["Sci-Fi"],
    releaseYear: 1979,
    duration: 162,
    directors: ["Andrei Tarkovsky"],
    actors: ["Alisa Freindlich"],
  });

  const [plan] = planDedupe(films, [sparse, rich], []);

  assert.equal(plan.survivorId, "b");
  assert.deepEqual(plan.duplicateIds, ["a"]);
});

test("gaps in the survivor are filled from the duplicates", () => {
  const survivor = film("a", {
    imageUrl: "https://img",
    genres: ["Sci-Fi"],
    releaseYear: 1979,
    duration: 162,
    directors: [],
    externalUrls: [{ name: "tmdb", url: "https://tmdb/1398" }],
  });
  const duplicate = film("b", {
    directors: ["Andrei Tarkovsky"],
    apiRefs: ["tmdb__1398", "imdb__tt0079944"],
    externalUrls: [{ name: "imdb", url: "https://imdb/tt0079944" }],
  });

  const [plan] = planDedupe(films, [survivor, duplicate], []);

  assert.equal(plan.survivorId, "a");
  assert.deepEqual(plan.updates.directors, ["Andrei Tarkovsky"]);
  assert.deepEqual(plan.updates.apiRefs, ["tmdb__1398", "imdb__tt0079944"]);
  assert.deepEqual(plan.updates.externalUrls, [
    { name: "tmdb", url: "https://tmdb/1398" },
    { name: "imdb", url: "https://imdb/tt0079944" },
  ]);
});

test("the survivor's own values are never replaced by a duplicate's", () => {
  const survivor = film("a", {
    imageUrl: "https://kept",
    genres: ["Sci-Fi"],
    releaseYear: 1979,
    duration: 162,
    directors: ["Andrei Tarkovsky"],
    actors: ["Alisa Freindlich"],
    externalUrls: [{ name: "tmdb", url: "https://kept" }],
  });
  const duplicate = film("b", {
    imageUrl: "https://other",
    externalUrls: [{ name: "tmdb", url: "https://other" }],
  });

  const [plan] = planDedupe(films, [survivor, duplicate], []);

  assert.equal(plan.survivorId, "a");
  assert.deepEqual(plan.updates, {});
});

test("entries pointing at a duplicate are repointed at the survivor", () => {
  const survivor = film("a", { imageUrl: "https://img" });
  const duplicate = film("b");
  const entries = [
    { _id: "e1", userId: "u1", workRef: "a" },
    { _id: "e2", userId: "u2", workRef: "b" },
    { _id: "e3", userId: "u3", workRef: "b" },
    { _id: "e4", userId: "u4", workRef: null },
  ];

  const [plan] = planDedupe(films, [survivor, duplicate], entries);

  assert.equal(plan.survivorId, "a");
  assert.deepEqual(plan.entriesToRepoint.sort(), ["e2", "e3"]);
});

test("equally complete duplicates are ranked by how many entries use them", () => {
  const entries = [
    { _id: "e1", workRef: "b" },
    { _id: "e2", workRef: "b" },
    { _id: "e3", workRef: "a" },
  ];

  const [plan] = planDedupe(films, [film("a"), film("b")], entries);

  assert.equal(plan.survivorId, "b");
  assert.deepEqual(plan.entriesToRepoint, ["e3"]);
});

test("otherwise identical duplicates are ordered deterministically", () => {
  const [forwards] = planDedupe(films, [film("a"), film("b")], []);
  const [backwards] = planDedupe(films, [film("b"), film("a")], []);

  assert.equal(forwards.survivorId, "a");
  assert.equal(backwards.survivorId, "a");
});

test("re-running after a completed merge finds nothing to do", () => {
  const survivor = film("a", { imageUrl: "https://img" });
  const duplicate = film("b");
  const entries = [{ _id: "e1", workRef: "b" }];

  const [plan] = planDedupe(films, [survivor, duplicate], entries);
  const merged = { ...survivor, ...plan.updates };
  const repointed = entries.map((e) => ({ ...e, workRef: plan.survivorId }));

  assert.deepEqual(planDedupe(films, [merged], repointed), []);
});

test("a book cached as ISBN__ and as google__ is one book", () => {
  assert.equal(
    groupKey(books, { apiRefs: ["ISBN__9780441013593"] }),
    groupKey(books, { apiRefs: ["google__9780441013593"] })
  );

  const plans = planDedupe(
    books,
    [
      { _id: "a", entryType: "Book", apiRefs: ["ISBN__9780441013593"] },
      { _id: "b", entryType: "Book", apiRefs: ["google__9780441013593"] },
    ],
    []
  );

  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].duplicateIds, ["b"]);
});

test("an hltb ref never establishes identity on its own", () => {
  const games = COLLECTIONS.find((c) => c.type === "games");

  // A HowLongToBeat id names a page, not the game, so two games that happen
  // to share one are not duplicates.
  assert.equal(groupKey(games, { apiRefs: ["hltb__100"] }), undefined);
  assert.equal(groupKey(games, { apiRefs: ["igdb__100"] }), "igdb__100");
});

test("games sharing the placeholder hltb__N/A are never grouped", () => {
  // 27 games carry this placeholder. Grouping on it would present them as
  // copies of one another and delete all but one.
  const games = COLLECTIONS.find((c) => c.type === "games");
  const placeholder = (id, title) => ({
    _id: id,
    entryType: "Game",
    englishTranslatedTitle: title,
    apiRefs: ["hltb__N/A"],
  });

  const works = [
    placeholder("a", "Cards Against Humanity"),
    placeholder("b", "Doom mod: Sigil"),
    placeholder("c", "Resident Evil 4: Separate Ways"),
  ];
  const entries = works.map((w, i) => ({ _id: `e${i}`, workRef: w._id }));

  assert.equal(groupKey(games, works[0]), undefined);
  assert.deepEqual(planDedupe(games, works, entries), []);
});

test("films with undefined__undefined refs are never grouped", () => {
  // 14 films in the database carry this.
  const works = ["a", "b", "c"].map((id) => ({
    _id: id,
    entryType: "Film",
    englishTranslatedTitle: `Film ${id}`,
    apiRefs: ["undefined__undefined"],
  }));

  assert.equal(groupKey(films, works[0]), undefined);
  assert.deepEqual(planDedupe(films, works, []), []);
});

test("a placeholder never masks a real identifier on the same work", () => {
  const games = COLLECTIONS.find((c) => c.type === "games");

  assert.equal(
    groupKey(games, { apiRefs: ["hltb__N/A", "igdb__14593"] }),
    "igdb__14593"
  );
});

test("works sharing an apiRef but not a title are not merged", () => {
  // "Fargo - Season 1" and "Fargo - Season 2" really do sit under one tmdb
  // id. Merging them would destroy one of the two seasons being tracked.
  const works = [
    film("a", { englishTranslatedTitle: "Fargo - Season 1", imageUrl: "https://img" }),
    film("b", { englishTranslatedTitle: "Fargo - Season 2" }),
  ];

  assert.deepEqual(planDedupe(films, works, []), []);

  const [forced] = planDedupe(films, works, [], {
    includeTitleMismatches: true,
  });
  assert.equal(forced.titlesAgree, false);
  assert.deepEqual(forced.titles, ["Fargo - Season 1", "Fargo - Season 2"]);
});

test("titles differing only in punctuation or case still count as agreeing", () => {
  const works = [
    film("a", { englishTranslatedTitle: "WALL·E", imageUrl: "https://img" }),
    film("b", { englishTranslatedTitle: "Wall-E" }),
  ];

  const [plan] = planDedupe(films, works, []);

  assert.equal(plan.titlesAgree, true);
  assert.deepEqual(plan.duplicateIds, ["b"]);
});

test("a mixed group is skipped whole rather than partly merged", () => {
  // Castlevania has Season 1 twice and Season 2 once under one id. The two
  // Season 1 documents are genuine duplicates, but sorting that out means
  // looking at it, so the whole group stays put.
  const works = [
    film("a", { englishTranslatedTitle: "Castlevania: Season 1" }),
    film("b", { englishTranslatedTitle: "Castlevania: Season 1" }),
    film("c", { englishTranslatedTitle: "Castlevania: Season 2" }),
  ];

  assert.deepEqual(planDedupe(films, works, []), []);
});
