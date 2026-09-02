const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  KEPT_FIELDS,
  poisonedFields,
  planSharedRefRepair,
} = require("./shared_ref_repair_plan");

const games = COLLECTIONS.find((c) => c.type === "games");
const films = COLLECTIONS.find((c) => c.type === "films");
const books = COLLECTIONS.find((c) => c.type === "books");
const tv = COLLECTIONS.find((c) => c.type === "tv");

/**
 * The pair as production holds it: one IGDB id, one HowLongToBeat id, and the
 * same year, playtime, image and links on both documents. Kingdom Hearts is a
 * 2002 PS2 game and is stored as a 2019 PS4 one taking 29 hours.
 */
const kingdomHeartsIII = {
  _id: "kh3",
  entryType: "Game",
  englishTranslatedTitle: "Kingdom Hearts III",
  apiRefs: ["igdb__2933", "hltb__13157"],
  imageUrl: "https://images.igdb.com/kh3.jpg",
  releaseYear: 2019,
  duration: 1740,
  durationSource: "igdb",
  genres: ["Role-playing (RPG)"],
  platforms: ["PS4", "XONE"],
  studios: ["Square Enix"],
  publishers: ["Square Enix"],
  externalUrls: [
    { name: "igdb", url: "https://www.igdb.com/games/kingdom-hearts-iii" },
  ],
  metadataUpdatedDate: 1750000000000,
};

const kingdomHearts = {
  ...kingdomHeartsIII,
  _id: "kh",
  englishTranslatedTitle: "Kingdom Hearts",
};

/** What the audit's identityChecks carry for one work: ../audit_database.js. */
const describe = (work) => ({
  id: work._id,
  title: work.englishTranslatedTitle,
  apiRefs: work.apiRefs,
});

const check = ({ apiRef, ref, apiTitle, matches = [], mismatches = [] }) => ({
  apiRef,
  ref,
  apiTitle,
  matches: matches.map(describe),
  mismatches: mismatches.map(describe),
});

const kingdomHeartsCheck = check({
  apiRef: "igdb__2933",
  ref: "2933",
  apiTitle: "Kingdom Hearts III",
  matches: [kingdomHeartsIII],
  mismatches: [kingdomHearts],
});

const idsOf = (repairs) => repairs.map((repair) => repair._id);
const fieldsOf = (repair) => repair.unset.map((entry) => entry.field);

///////////////////////////////////////////////////////////////////////////////
// Which works lose the ref

test("only the work the API called misfiled is repaired", () => {
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(idsOf(plan.repairs), ["kh"]);
  assert.deepEqual(
    plan.untouched.map((work) => work._id),
    ["kh3"]
  );
  assert.equal(plan.totals.ownerConfirmed, 1);
  assert.equal(plan.totals.thirdWork, 0);
});

test("a group the API says is neither of them loses every work's ref", () => {
  // igdb__134258 is New Play Control! Metroid Prime 2, so there is no side to
  // pick and both documents are wearing an id that is not theirs.
  const metroid = {
    _id: "m",
    englishTranslatedTitle: "Metroid",
    apiRefs: ["igdb__134258"],
    releaseYear: 1986,
  };
  const metroidPrime = {
    _id: "mp",
    englishTranslatedTitle: "Metroid Prime",
    apiRefs: ["igdb__134258"],
    releaseYear: 2002,
  };

  const plan = planSharedRefRepair(
    games,
    [metroid, metroidPrime],
    [
      check({
        apiRef: "igdb__134258",
        ref: "134258",
        apiTitle: "Metroid Prime 2: Echoes",
        mismatches: [metroid, metroidPrime],
      }),
    ]
  );

  assert.deepEqual(idsOf(plan.repairs), ["m", "mp"]);
  assert.deepEqual(plan.untouched, []);
  assert.deepEqual(
    plan.repairs.map((repair) => repair.owner),
    [null, null]
  );
  assert.equal(plan.totals.ownerConfirmed, 0);
  assert.equal(plan.totals.thirdWork, 1);
});

test("the verdicts come from the checks, not from a list in the module", () => {
  // The same two documents, with the API naming the other one. Nothing in the
  // plan may prefer the sequel on its own account.
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [
      check({
        apiRef: "igdb__2933",
        ref: "2933",
        apiTitle: "Kingdom Hearts",
        matches: [kingdomHearts],
        mismatches: [kingdomHeartsIII],
      }),
    ]
  );

  assert.deepEqual(idsOf(plan.repairs), ["kh3"]);
  assert.deepEqual(
    plan.untouched.map((work) => work._id),
    ["kh"]
  );
});

test("a check that could not be asked is skipped, not guessed at", () => {
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [
      {
        apiRef: "igdb__2933",
        ref: "2933",
        error: "429 Too Many Requests",
        works: [kingdomHeartsIII, kingdomHearts].map(describe),
      },
    ]
  );

  assert.deepEqual(plan.repairs, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /could not be asked/);
  assert.equal(plan.totals.ownerConfirmed, 0);
  assert.equal(plan.totals.thirdWork, 0);
});

test("a check naming a work the collection no longer holds is skipped", () => {
  const plan = planSharedRefRepair(games, [kingdomHeartsIII], [kingdomHeartsCheck]);

  assert.deepEqual(plan.repairs, []);
  assert.match(plan.skipped[0].reason, /not in games any more/);
});

test("a work that has already lost the ref is skipped rather than emptied", () => {
  const repaired = { ...kingdomHearts, apiRefs: [] };
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, repaired],
    [kingdomHeartsCheck]
  );

  assert.deepEqual(plan.repairs, []);
  assert.match(plan.skipped[0].reason, /no longer carries igdb__2933/);
});

test("a work called both the owner and a mismatch blocks the whole plan", () => {
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [
      check({
        apiRef: "igdb__2933",
        ref: "2933",
        apiTitle: "Kingdom Hearts III",
        matches: [kingdomHeartsIII],
        mismatches: [kingdomHeartsIII, kingdomHearts],
      }),
    ]
  );

  assert.match(plan.blocked, /both the work the id names and a work it does not/);
  assert.deepEqual(plan.repairs, []);
});

///////////////////////////////////////////////////////////////////////////////
// Which ids come off

test("the shared HowLongToBeat id goes with the IGDB one", () => {
  // Nothing grouped on hltb__13157 — it is not an identity ref — but two games
  // do not share a HowLongToBeat page, and the retrieve that wrote one of
  // these wrote the other.
  const [repair] = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  ).repairs;

  assert.deepEqual(repair.removedRefs, ["igdb__2933", "hltb__13157"]);
  assert.deepEqual(repair.apiRefs, []);
});

test("an id only the misfiled work carries is left alone", () => {
  const withOwnRef = { ...kingdomHearts, apiRefs: ["igdb__2933", "hltb__2222"] };
  const [repair] = planSharedRefRepair(
    games,
    [kingdomHeartsIII, withOwnRef],
    [
      check({
        apiRef: "igdb__2933",
        ref: "2933",
        apiTitle: "Kingdom Hearts III",
        matches: [kingdomHeartsIII],
        mismatches: [withOwnRef],
      }),
    ]
  ).repairs;

  assert.deepEqual(repair.removedRefs, ["igdb__2933"]);
  assert.deepEqual(repair.apiRefs, ["hltb__2222"]);
});

test("a book stored under google__ loses the same ISBN as one under ISBN__", () => {
  const demons = {
    _id: "d",
    englishTranslatedTitle: "Demons",
    apiRefs: ["google__9782709637411"],
    duration: 600,
  };
  const daVinciCode = {
    _id: "dv",
    englishTranslatedTitle: "The Da Vinci Code",
    apiRefs: ["ISBN__9782709637411"],
    duration: 600,
  };

  const plan = planSharedRefRepair(
    books,
    [demons, daVinciCode],
    [
      check({
        apiRef: "9782709637411",
        ref: "9782709637411",
        apiTitle: "Anges et démons",
        mismatches: [demons, daVinciCode],
      }),
    ]
  );

  assert.deepEqual(
    plan.repairs.map((repair) => repair.removedRefs),
    [["google__9782709637411"], ["ISBN__9782709637411"]]
  );
});

test("a placeholder ref is neither shared nor removed", () => {
  // 27 games carry hltb__N/A, which names nothing, so it cannot be evidence
  // that two documents came from one retrieve.
  const a = {
    _id: "a",
    englishTranslatedTitle: "Wii Play",
    apiRefs: ["igdb__5281", "hltb__N/A"],
  };
  const b = {
    _id: "b",
    englishTranslatedTitle: "Wii Play: Motion",
    apiRefs: ["igdb__5281", "hltb__N/A"],
  };

  const [repair] = planSharedRefRepair(
    games,
    [a, b],
    [
      check({
        apiRef: "igdb__5281",
        ref: "5281",
        apiTitle: "Wii Play: Motion",
        matches: [b],
        mismatches: [a],
      }),
    ]
  ).repairs;

  assert.deepEqual(repair.removedRefs, ["igdb__5281"]);
  assert.deepEqual(repair.apiRefs, ["hltb__N/A"]);
});

test("apiRefs is narrowed to an empty array, never unset", () => {
  // An absent apiRefs is what corruptFieldsOf calls corrupt, so unsetting it
  // would trade one finding for another.
  const [repair] = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  ).repairs;

  assert.deepEqual(repair.apiRefs, []);
  assert.ok(!fieldsOf(repair).includes("apiRefs"));
  assert.ok("apiRefs" in KEPT_FIELDS);
});

///////////////////////////////////////////////////////////////////////////////
// Which fields come off

test("every field an adapter fills is unset, and the titles are not", () => {
  const [repair] = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  ).repairs;

  assert.deepEqual(fieldsOf(repair), [
    "imageUrl",
    "releaseYear",
    "duration",
    "genres",
    "platforms",
    "studios",
    "publishers",
    "externalUrls",
    "durationSource",
    "metadataUpdatedDate",
  ]);
  assert.deepEqual(
    repair.unset.find((entry) => entry.field === "releaseYear").value,
    2019
  );
});

test("the fields that survive are the ones that identify the work", () => {
  assert.deepEqual(Object.keys(KEPT_FIELDS), [
    "englishTranslatedTitle",
    "originalTitle",
    "entryType",
    "apiRefs",
  ]);
  for (const collection of COLLECTIONS) {
    for (const kept of Object.keys(KEPT_FIELDS)) {
      assert.ok(
        !poisonedFields(collection).includes(kept),
        `${collection.type} would clear ${kept}`
      );
    }
  }
});

test("a type's own metadata fields are read out of its descriptor", () => {
  // The list is not written down anywhere, so a type that grows a field is
  // covered without anyone remembering to come back.
  assert.deepEqual(poisonedFields(books), [
    "imageUrl",
    "releaseYear",
    "duration",
    "genres",
    "authors",
    "publishers",
    "externalUrls",
    "durationSource",
    "metadataUpdatedDate",
  ]);
  assert.ok(poisonedFields(films).includes("directors"));
  assert.ok(poisonedFields(films).includes("actors"));
  assert.ok(poisonedFields(tv).includes("episodes"));
});

test("a field the work does not have is not listed as something to unset", () => {
  const sparse = {
    _id: "hero",
    englishTranslatedTitle: "Hero",
    apiRefs: ["tmdb__177572"],
    releaseYear: 2014,
    genres: [],
  };
  const bigHero6 = {
    _id: "bh6",
    englishTranslatedTitle: "Big Hero 6",
    apiRefs: ["tmdb__177572"],
    releaseYear: 2014,
  };

  const [repair] = planSharedRefRepair(
    films,
    [bigHero6, sparse],
    [
      check({
        apiRef: "tmdb__177572",
        ref: "177572",
        apiTitle: "Big Hero 6",
        matches: [bigHero6],
        mismatches: [sparse],
      }),
    ]
  ).repairs;

  assert.deepEqual(fieldsOf(repair), ["releaseYear"]);
});

test("a duration of 0 is a value, and is unset with the rest", () => {
  // CLAUDE.md: a stored duration of 0 renders as `-` exactly as a missing one
  // does, but it is still a number the wrong work put there.
  const zero = { ...kingdomHearts, duration: 0 };
  const [repair] = planSharedRefRepair(
    games,
    [kingdomHeartsIII, zero],
    [kingdomHeartsCheck]
  ).repairs;

  assert.ok(fieldsOf(repair).includes("duration"));
  assert.ok(fieldsOf(repair).includes("durationSource"));
});

///////////////////////////////////////////////////////////////////////////////
// What the repaired works become

test("a work with no identity ref left is counted as unrefreshable", () => {
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  );

  assert.equal(plan.repairs[0].unrefreshable, true);
  assert.equal(plan.totals.unrefreshableBefore, 0);
  assert.equal(plan.totals.unrefreshableAfter, 1);
});

test("a work keeping another identity ref stays refreshable", () => {
  // "Refreshable" is the audit's own question — a ref under the prefix the
  // adapter retrieves by — so a second ISBN is what keeps a book in reach and
  // a leftover google__ or hltb__ would not.
  const other = {
    _id: "d",
    englishTranslatedTitle: "Demons",
    apiRefs: ["ISBN__9782709637411", "ISBN__9780140442076"],
  };
  const daVinciCode = {
    _id: "dv",
    englishTranslatedTitle: "The Da Vinci Code",
    apiRefs: ["ISBN__9782709637411"],
  };

  const plan = planSharedRefRepair(
    books,
    [other, daVinciCode],
    [
      check({
        apiRef: "9782709637411",
        ref: "9782709637411",
        apiTitle: "Anges et démons",
        mismatches: [other, daVinciCode],
      }),
    ]
  );

  const [demons, dv] = plan.repairs;
  assert.deepEqual(demons.apiRefs, ["ISBN__9780140442076"]);
  assert.equal(demons.unrefreshable, false);
  assert.equal(demons.remainingIdentityRef, "9780140442076");
  assert.equal(dv.unrefreshable, true);
  assert.equal(plan.totals.unrefreshableAfter, 1);
});

test("a work already unrefreshable is not counted twice", () => {
  const noRef = { _id: "x", englishTranslatedTitle: "Doom mod: Sigil", apiRefs: [] };
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts, noRef],
    [kingdomHeartsCheck]
  );

  assert.equal(plan.totals.unrefreshableBefore, 1);
  assert.equal(plan.totals.unrefreshableAfter, 2);
});

test("the totals add up the way the report prints them", () => {
  const plan = planSharedRefRepair(
    games,
    [kingdomHeartsIII, kingdomHearts],
    [kingdomHeartsCheck]
  );

  assert.deepEqual(plan.totals, {
    works: 2,
    groups: 1,
    ownerConfirmed: 1,
    thirdWork: 0,
    repaired: 1,
    refs: 2,
    values: 10,
    unrefreshableBefore: 0,
    unrefreshableAfter: 1,
  });
});

///////////////////////////////////////////////////////////////////////////////
// Refusals

test("tv is refused: sharing a show id is how the site works", () => {
  const plan = planSharedRefRepair(
    tv,
    [],
    [check({ apiRef: "tmdb__60622", ref: "60622", apiTitle: "Fargo" })]
  );

  assert.match(plan.blocked, /shares ids by design/);
});

test("tv with nothing to repair is not an error", () => {
  const plan = planSharedRefRepair(tv, [], []);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.repairs, []);
});

test("a descriptor that cannot say which ids name the work is refused", () => {
  const plan = planSharedRefRepair({ type: "games" }, [], []);

  assert.match(plan.blocked, /identityPrefixes/);
});

test("identityChecks has to be the audit's array", () => {
  assert.match(
    planSharedRefRepair(games, [], undefined).blocked,
    /identityChecks must be an array/
  );
  assert.match(planSharedRefRepair(games, undefined, []).blocked, /works must be/);
});
