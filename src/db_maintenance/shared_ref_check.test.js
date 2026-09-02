const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  SHARED_IDENTITY_REF_BY_DESIGN,
  sharedRefReason,
  classifySharedRefs,
  identityRefOf,
  resolveIdentity,
} = require("./shared_ref_check");

const games = COLLECTIONS.find((c) => c.type === "games");
const films = COLLECTIONS.find((c) => c.type === "films");
const tv = COLLECTIONS.find((c) => c.type === "tv");
const books = COLLECTIONS.find((c) => c.type === "books");

const game = (id, title, extra) => ({
  _id: id,
  entryType: "Game",
  englishTranslatedTitle: title,
  apiRefs: ["igdb__2933"],
  ...extra,
});

const show = (id, title) => ({
  _id: id,
  entryType: "TVShow",
  englishTranslatedTitle: title,
  apiRefs: ["tmdb__60622"],
});

const idsOf = (works) => works.map((work) => work._id);
const keysOf = (groups) => groups.map((group) => group.key);

///////////////////////////////////////////////////////////////////////////////
// Which of the three things a group is

test("the pair from the issue is a collision, not a duplicate", () => {
  // games/igdb__2933: Kingdom Hearts III's id, with Kingdom Hearts filed under
  // it and drawn as a 2019 game taking 29 hours.
  const works = [
    game("a", "Kingdom Hearts III"),
    game("b", "Kingdom Hearts"),
  ];

  const { duplicates, expected, collisions } = classifySharedRefs(games, works);

  assert.deepEqual(keysOf(duplicates), []);
  assert.deepEqual(keysOf(expected), []);
  assert.deepEqual(keysOf(collisions), ["igdb__2933"]);
  assert.equal(collisions[0].ref, "2933");
});

test("two copies of one work are a duplicate wherever they are", () => {
  const works = [
    game("a", "Kingdom Hearts III"),
    game("b", "kingdom hearts: III!"),
  ];

  const { duplicates, collisions } = classifySharedRefs(games, works);

  assert.deepEqual(keysOf(duplicates), ["igdb__2933"]);
  assert.deepEqual(keysOf(collisions), []);
});

test("seasons under one show id are expected, and are not counted as damage", () => {
  // The nineteen groups that made the old headline unreadable: TMDB has one id
  // per show, and they can never go to zero.
  const works = [show("a", "Fargo - Season 1"), show("b", "Fargo - Season 2")];

  const { duplicates, expected, collisions } = classifySharedRefs(tv, works);

  assert.deepEqual(keysOf(duplicates), []);
  assert.deepEqual(keysOf(expected), ["tmdb__60622"]);
  assert.deepEqual(keysOf(collisions), []);
});

test("tv is excused a disagreement, not the sharing itself", () => {
  // Two documents for the same season are still two documents for the same
  // season, and dedupe_works.js is still what collapses them.
  const works = [show("a", "Fargo - Season 1"), show("b", "Fargo — Season 1")];

  const { duplicates, expected } = classifySharedRefs(tv, works);

  assert.deepEqual(keysOf(duplicates), ["tmdb__60622"]);
  assert.deepEqual(keysOf(expected), []);
});

test("a group of one is not a group", () => {
  const { duplicates, expected, collisions } = classifySharedRefs(games, [
    game("a", "Kingdom Hearts III"),
  ]);

  assert.deepEqual([...duplicates, ...expected, ...collisions], []);
});

test("only tv is expected to share an id, and it says why", () => {
  assert.equal(sharedRefReason(games), undefined);
  assert.equal(sharedRefReason(films), undefined);
  assert.equal(sharedRefReason(books), undefined);
  assert.match(sharedRefReason(tv), /one id per show/);
  assert.deepEqual(Object.keys(SHARED_IDENTITY_REF_BY_DESIGN), ["tv"]);
});

///////////////////////////////////////////////////////////////////////////////
// The id to ask the adapter about

test("the ref handed to retrieve is bare, with no prefix on it", () => {
  const { collisions } = classifySharedRefs(films, [
    { _id: "a", englishTranslatedTitle: "Hero", apiRefs: ["tmdb__177572"] },
    { _id: "b", englishTranslatedTitle: "Big Hero 6", apiRefs: ["tmdb__177572"] },
  ]);

  assert.equal(collisions[0].key, "tmdb__177572");
  assert.equal(collisions[0].ref, "177572");
});

test("a book stored only under google__ still yields its ISBN", () => {
  // Both prefixes name the same ISBN, and some documents carry only the
  // second — the group key is already bare for books, but the id has to come
  // from somewhere either way.
  const works = [
    { _id: "a", englishTranslatedTitle: "Demons", apiRefs: ["google__9782709637411"] },
    {
      _id: "b",
      englishTranslatedTitle: "The Da Vinci Code",
      apiRefs: ["ISBN__9782709637411"],
    },
  ];

  assert.equal(identityRefOf(books, works), "9782709637411");
  assert.equal(classifySharedRefs(books, works).collisions[0].ref, "9782709637411");
});

test("a placeholder ref names nothing and cannot be asked about", () => {
  // 27 games carry `hltb__N/A`. Grouping on one would present unrelated games
  // as copies of each other, and `parseApiRef` is what stops it.
  const works = [
    { _id: "a", englishTranslatedTitle: "Blood", apiRefs: ["hltb__N/A"] },
    { _id: "b", englishTranslatedTitle: "Thief", apiRefs: ["hltb__N/A"] },
  ];

  assert.equal(identityRefOf(games, works), undefined);
  const { duplicates, expected, collisions } = classifySharedRefs(games, works);
  assert.deepEqual([...duplicates, ...expected, ...collisions], []);
});

///////////////////////////////////////////////////////////////////////////////
// What the adapter's answer settles

test("the API names one of the pair, and the other is the misfiled one", () => {
  const [group] = classifySharedRefs(games, [
    game("a", "Kingdom Hearts III"),
    game("b", "Kingdom Hearts"),
  ]).collisions;

  const resolved = resolveIdentity(group, {
    englishTranslatedTitle: "Kingdom Hearts III",
    releaseYear: 2019,
  });

  assert.equal(resolved.apiTitle, "Kingdom Hearts III");
  assert.deepEqual(idsOf(resolved.matches), ["a"]);
  assert.deepEqual(idsOf(resolved.mismatches), ["b"]);
});

test("punctuation and case are not a disagreement", () => {
  const [group] = classifySharedRefs(films, [
    { _id: "a", englishTranslatedTitle: "WALL·E", apiRefs: ["tmdb__10681"] },
    { _id: "b", englishTranslatedTitle: "Ratatouille", apiRefs: ["tmdb__10681"] },
  ]).collisions;

  const resolved = resolveIdentity(group, { englishTranslatedTitle: "Wall-E" });

  assert.deepEqual(idsOf(resolved.matches), ["a"]);
});

test("either title may match either title", () => {
  // TMDB and IGDB disagree often enough about which spelling is the original
  // that insisting on the same field would invent a difference.
  const [group] = classifySharedRefs(films, [
    {
      _id: "a",
      englishTranslatedTitle: "Ring",
      originalTitle: "リング",
      apiRefs: ["tmdb__565"],
    },
    { _id: "b", englishTranslatedTitle: "The Ring", apiRefs: ["tmdb__565"] },
  ]).collisions;

  const resolved = resolveIdentity(group, {
    englishTranslatedTitle: "Ringu",
    originalTitle: "リング",
  });

  assert.deepEqual(idsOf(resolved.matches), ["a"]);
  assert.deepEqual(idsOf(resolved.mismatches), ["b"]);
});

test("an answer that names neither is reported, not forced onto one of them", () => {
  const [group] = classifySharedRefs(games, [
    game("a", "Kingdom Hearts III"),
    game("b", "Kingdom Hearts"),
  ]).collisions;

  const resolved = resolveIdentity(group, { englishTranslatedTitle: "Bloodborne" });

  assert.deepEqual(resolved.matches, []);
  assert.deepEqual(idsOf(resolved.mismatches), ["a", "b"]);
});

test("an untitled work is not made the match by elimination", () => {
  const [group] = classifySharedRefs(games, [
    game("a", "Kingdom Hearts III"),
    game("b", undefined),
  ]).collisions;

  const resolved = resolveIdentity(group, {
    englishTranslatedTitle: "Kingdom Hearts II",
  });

  assert.deepEqual(resolved.matches, []);
  assert.deepEqual(idsOf(resolved.mismatches), ["a", "b"]);
});
