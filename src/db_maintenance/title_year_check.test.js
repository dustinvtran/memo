const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  titleYearKey,
  classifyTitleYearGroups,
  bucketOf,
  reasonFor,
  distinctIdentityRefs,
  sharedSecondaryRefs,
  usableDuration,
  resolveTitleYear,
  freshWorksAgree,
} = require("./title_year_check");

const games = COLLECTIONS.find((c) => c.type === "games");
const films = COLLECTIONS.find((c) => c.type === "films");
const tv = COLLECTIONS.find((c) => c.type === "tv");
const books = COLLECTIONS.find((c) => c.type === "books");

const game = (id, extra) => ({
  _id: id,
  entryType: "Game",
  englishTranslatedTitle: "System Shock",
  releaseYear: 1994,
  ...extra,
});

const film = (id, extra) => ({
  _id: id,
  entryType: "Film",
  englishTranslatedTitle: "Stalker",
  releaseYear: 1979,
  ...extra,
});

const entriesFor = (...workRefs) =>
  workRefs.map((workRef, index) => ({ _id: `e${index}`, workRef }));

const idsOf = (groups) => groups.map((group) => group.works.map((w) => w.id));
const keysOf = (groups) => groups.map((group) => group.key);

///////////////////////////////////////////////////////////////////////////////
// The key, and what has none

test("the key is the normalised title and the year", () => {
  assert.equal(
    titleYearKey({ englishTranslatedTitle: "Demon's Souls", releaseYear: 2009 }),
    "demonssouls|2009"
  );
});

test("punctuation and spacing are not a difference", () => {
  // The real tv pair: one document titled "Squidgame", one "Squid Game".
  assert.equal(
    titleYearKey({ englishTranslatedTitle: "Squidgame", releaseYear: 2021 }),
    titleYearKey({ englishTranslatedTitle: "Squid Game", releaseYear: 2021 })
  );
});

test("a work with no title has no key, rather than the key '(untitled)'", () => {
  // displayTitle answers "(untitled)", which would otherwise be a perfectly
  // good key that every untitled work of that year shares.
  assert.equal(titleYearKey({ releaseYear: 1994 }), undefined);
  assert.equal(titleYearKey({ englishTranslatedTitle: "  ", releaseYear: 1994 }), undefined);
});

test("a work with no usable release year has no key", () => {
  const title = "System Shock";
  assert.equal(titleYearKey({ englishTranslatedTitle: title }), undefined);
  assert.equal(
    titleYearKey({ englishTranslatedTitle: title, releaseYear: null }),
    undefined
  );
  assert.equal(
    titleYearKey({ englishTranslatedTitle: title, releaseYear: "1994" }),
    undefined
  );
  assert.equal(
    titleYearKey({ englishTranslatedTitle: title, releaseYear: NaN }),
    undefined
  );
});

test("two untitled works of one year are not a group", () => {
  const { duplicates, unidentified, undecided } = classifyTitleYearGroups(games, [
    { _id: "a", releaseYear: 1994, apiRefs: ["igdb__1"] },
    { _id: "b", releaseYear: 1994, apiRefs: ["igdb__2"] },
  ]);

  assert.deepEqual([...duplicates, ...unidentified, ...undecided], []);
});

test("a group of one is not a group", () => {
  const { duplicates, unidentified, undecided } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__23"] }),
  ]);

  assert.deepEqual([...duplicates, ...unidentified, ...undecided], []);
});

///////////////////////////////////////////////////////////////////////////////
// What this check is for, and what it leaves to the one next door

test("works already under one identity ref are left to the apiRef check", () => {
  // Two copies under igdb__23 is what classifySharedRefs reports and what
  // planDedupe collapses. Reporting it here too would be the same pair counted
  // twice under two headings that mean different things.
  const { duplicates, unidentified, undecided } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__23"] }),
    game("b", { apiRefs: ["igdb__23"] }),
  ]);

  assert.deepEqual([...duplicates, ...unidentified, ...undecided], []);
});

test("ISBN__x and google__x are one id, so that pair is left there too", () => {
  const { duplicates, unidentified, undecided } = classifyTitleYearGroups(books, [
    {
      _id: "a",
      englishTranslatedTitle: "Gardens of the Moon",
      releaseYear: 2004,
      apiRefs: ["ISBN__9780765310019"],
    },
    {
      _id: "b",
      englishTranslatedTitle: "Gardens of the Moon",
      releaseYear: 2004,
      apiRefs: ["google__9780765310019"],
    },
  ]);

  assert.deepEqual([...duplicates, ...unidentified, ...undecided], []);
});

test("a trio where only two share an id is reported in full", () => {
  // The third is what makes it a finding, and dropping the other two would
  // hide which document it is a candidate copy of.
  const { duplicates } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__23"], duration: 780 }),
    game("b", { apiRefs: ["igdb__23"], duration: 780 }),
    game("c", { apiRefs: ["igdb__18375"], duration: 780 }),
  ]);

  assert.deepEqual(idsOf(duplicates), [["a", "b", "c"]]);
  // Two questions, not three: the shared id is asked about once.
  assert.deepEqual(
    duplicates[0].refs.map((r) => r.apiRef),
    ["igdb__23", "igdb__18375"]
  );
});

///////////////////////////////////////////////////////////////////////////////
// Duplicates: the signals that say two ids are one work

test("a shared hltb id across two igdb ids is the tell", () => {
  // system shock|1994, as production holds it.
  const { duplicates } = classifyTitleYearGroups(
    games,
    [
      game("a", { apiRefs: ["igdb__18375", "hltb__9547"], duration: 780 }),
      game("b", { apiRefs: ["igdb__23", "hltb__9547"], duration: 780 }),
    ],
    entriesFor("a", "b")
  );

  assert.deepEqual(keysOf(duplicates), ["systemshock|1994"]);
  assert.deepEqual(duplicates[0].signals.sharedRefs, ["hltb__9547"]);
  assert.equal(duplicates[0].signals.listedTwice, true);
  assert.match(duplicates[0].reason, /hltb__9547/);
  assert.match(duplicates[0].reason, /listed on the site today/);
});

test("an identical duration is enough on its own", () => {
  // super mario odyssey|2017: two igdb ids, 780 minutes each, no hltb id.
  const { duplicates } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__132640"], duration: 780 }),
    game("b", { apiRefs: ["igdb__26758"], duration: 780 }),
  ]);

  assert.deepEqual(keysOf(duplicates), ["systemshock|1994"]);
  assert.equal(duplicates[0].signals.sameDuration, true);
  assert.equal(duplicates[0].signals.listedTwice, false);
  assert.match(duplicates[0].reason, /identical duration \(780 min\)/);
});

test("a stored duration of 0 is not a duration two works can agree on", () => {
  // CLAUDE.md: 0 renders as `-` exactly as a missing one does, so agreeing on
  // it is two works with no playtime and evidence of nothing.
  const { duplicates, undecided } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__1"], duration: 0 }),
    game("b", { apiRefs: ["igdb__2"], duration: 0 }),
  ]);

  assert.deepEqual(duplicates, []);
  assert.deepEqual(keysOf(undecided), ["systemshock|1994"]);
});

test("two works with no duration at all do not agree either", () => {
  const { duplicates, undecided } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: ["igdb__1"] }),
    game("b", { apiRefs: ["igdb__2"] }),
  ]);

  assert.deepEqual(duplicates, []);
  assert.deepEqual(keysOf(undecided), ["systemshock|1994"]);
});

test("the placeholder hltb__N/A is not a shared ref", () => {
  // 27 games carry it. Counting it would make every one of them a copy of
  // every other with the same name.
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      game("a", { apiRefs: ["igdb__1", "hltb__N/A"] }),
      game("b", { apiRefs: ["igdb__2", "hltb__N/A"] }),
    ]),
    []
  );
});

test("a shared identity ref is not a secondary signal", () => {
  // Only a ref from somewhere else is evidence. For films, tv and books there
  // is no such prefix at all, so the duration is the only signal they have.
  assert.deepEqual(
    sharedSecondaryRefs(films, [
      film("a", { apiRefs: ["tmdb__1398"] }),
      film("b", { apiRefs: ["tmdb__1398"] }),
    ]),
    []
  );
});

test("one work carrying a ref twice does not make it shared", () => {
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      game("a", { apiRefs: ["igdb__1", "hltb__9547", "hltb__9547"] }),
      game("b", { apiRefs: ["igdb__2"] }),
    ]),
    []
  );
});

///////////////////////////////////////////////////////////////////////////////
// Unidentified: the pair only a title can find

test("a work stripped of its id beside one that kept its own", () => {
  // resident evil 2|1998, after #308 took the misfiled id back off one of them.
  // Nothing can refresh the stripped document, and no ref connects the two.
  const { unidentified } = classifyTitleYearGroups(
    games,
    [
      {
        _id: "a",
        englishTranslatedTitle: "Resident Evil 2",
        releaseYear: 1998,
        apiRefs: [],
        duration: 540,
      },
      {
        _id: "b",
        englishTranslatedTitle: "Resident Evil 2",
        releaseYear: 1998,
        apiRefs: ["igdb__880", "hltb__57479"],
        duration: 510,
      },
    ],
    entriesFor("b")
  );

  assert.deepEqual(keysOf(unidentified), ["residentevil2|1998"]);
  assert.deepEqual(unidentified[0].works.map((w) => w.identityRef), [
    null,
    "igdb__880",
  ]);
  assert.deepEqual(unidentified[0].works.map((w) => w.entries), [0, 1]);
  assert.match(unidentified[0].reason, /1 of 2 carry no identity ref/);
});

test("only the id-less side is asked about, because it is the only one there is", () => {
  const { unidentified } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: [] }),
    game("b", { apiRefs: ["igdb__880"] }),
  ]);

  assert.deepEqual(
    unidentified[0].refs.map((r) => r.ref),
    ["880"]
  );
});

test("having no id wins over an identical duration", () => {
  // Different problem, different repair: nothing can refresh that document
  // whatever it turns out to be, and no other check here can see the pair.
  const { duplicates, unidentified } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: [], duration: 780 }),
    game("b", { apiRefs: ["igdb__23"], duration: 780 }),
  ]);

  assert.deepEqual(duplicates, []);
  assert.deepEqual(keysOf(unidentified), ["systemshock|1994"]);
});

test("two works that both have no id are not a reconciliation", () => {
  // There is nothing to repoint at: neither can be refreshed.
  const { unidentified, undecided } = classifyTitleYearGroups(games, [
    game("a", { apiRefs: [] }),
    game("b", { apiRefs: ["hltb__9547"] }),
  ]);

  assert.deepEqual(unidentified, []);
  assert.deepEqual(keysOf(undecided), ["systemshock|1994"]);
});

///////////////////////////////////////////////////////////////////////////////
// Undecided: the ones that are usually not duplicates at all

test("two films of one name and one year with different runtimes", () => {
  // stalker|1979: 83 minutes under tmdb__621300, 162 under tmdb__1398.
  // Tarkovsky's is the 162, and merging on the title would destroy the other.
  const { duplicates, undecided } = classifyTitleYearGroups(
    films,
    [
      film("a", { apiRefs: ["tmdb__621300"], duration: 83 }),
      film("b", { apiRefs: ["tmdb__1398"], duration: 162 }),
    ],
    entriesFor("b")
  );

  assert.deepEqual(duplicates, []);
  assert.deepEqual(keysOf(undecided), ["stalker|1979"]);
  assert.equal(undecided[0].signals.listedTwice, false);
  assert.match(undecided[0].reason, /durations 83 \/ 162/);
});

test("three films under one name, which is what a merge on titles would eat", () => {
  const { undecided } = classifyTitleYearGroups(films, [
    { _id: "a", englishTranslatedTitle: "Mother", releaseYear: 2009, apiRefs: ["tmdb__37080"], duration: 125 },
    { _id: "b", englishTranslatedTitle: "Mother", releaseYear: 2009, apiRefs: ["tmdb__698885"], duration: 20 },
    { _id: "c", englishTranslatedTitle: "Mother", releaseYear: 2009, apiRefs: ["tmdb__30018"], duration: 129 },
  ]);

  assert.deepEqual(idsOf(undecided), [["a", "b", "c"]]);
  assert.deepEqual(
    undecided[0].refs.map((r) => r.apiRef),
    ["tmdb__37080", "tmdb__698885", "tmdb__30018"]
  );
});

test("a pair a reader is looking at twice says so, whichever bucket it is in", () => {
  // medievil|2019 has one entry on each document and is still probably the
  // 1998 original beside the 2019 remake. The signal is impact, not a verdict.
  const { undecided } = classifyTitleYearGroups(
    games,
    [
      game("a", { apiRefs: ["igdb__4002", "hltb__5797"], duration: 390 }),
      game("b", { apiRefs: ["igdb__76960", "hltb__65969"], duration: 540 }),
    ],
    entriesFor("a", "b")
  );

  assert.equal(undecided[0].signals.listedTwice, true);
  assert.match(undecided[0].reason, /both are listed on the site today/);
});

test("tv is not excused here the way it is for a shared show id", () => {
  // Seasons under one show id are expected because they are named differently.
  // Two documents with the same name and the same year are not that.
  const { unidentified } = classifyTitleYearGroups(tv, [
    { _id: "a", englishTranslatedTitle: "Squidgame", releaseYear: 2021, apiRefs: [] },
    { _id: "b", englishTranslatedTitle: "Squid Game", releaseYear: 2021, apiRefs: ["tmdb__93405"] },
  ]);

  assert.deepEqual(keysOf(unidentified), ["squidgame|2021"]);
});

///////////////////////////////////////////////////////////////////////////////
// The pieces the buckets are built from

test("a duration of zero is reported as no duration", () => {
  assert.equal(usableDuration({ duration: 780 }), 780);
  assert.equal(usableDuration({ duration: 0 }), undefined);
  assert.equal(usableDuration({ duration: null }), undefined);
  assert.equal(usableDuration({ duration: "780" }), undefined);
  assert.equal(usableDuration({}), undefined);
});

test("a book is asked about by whichever of its two prefixes it carries", () => {
  assert.deepEqual(
    distinctIdentityRefs(books, [
      { _id: "a", apiRefs: ["google__9782709637411"] },
      { _id: "b", apiRefs: ["ISBN__0756404738"] },
    ]),
    [
      { apiRef: "google__9782709637411", ref: "9782709637411" },
      { apiRef: "ISBN__0756404738", ref: "0756404738" },
    ]
  );
});

test("an hltb id is never something to retrieve a game by", () => {
  assert.deepEqual(distinctIdentityRefs(games, [{ _id: "a", apiRefs: ["hltb__9547"] }]), []);
});

test("bucketOf and reasonFor answer about the same signals", () => {
  const group = {
    works: [{ duration: 780 }, { duration: 780 }],
    refs: [{ apiRef: "igdb__1" }, { apiRef: "igdb__2" }],
    signals: {
      sharedRefs: [],
      sameDuration: true,
      withoutIdentityRef: 0,
      listedTwice: false,
    },
  };

  assert.equal(bucketOf(group), "duplicates");
  assert.equal(reasonFor(group), "identical duration (780 min)");
});

///////////////////////////////////////////////////////////////////////////////
// What the adapters' answers settle

const group = {
  key: "systemshock|1994",
  title: "System Shock",
  releaseYear: 1994,
  refs: [
    { apiRef: "igdb__18375", ref: "18375" },
    { apiRef: "igdb__23", ref: "23" },
  ],
};

test("two ids that name the same title and year are one work", () => {
  const resolved = resolveTitleYear(group, [
    { apiRef: "igdb__18375", ref: "18375", fresh: { englishTranslatedTitle: "System Shock", releaseYear: 1994 } },
    { apiRef: "igdb__23", ref: "23", fresh: { englishTranslatedTitle: "System Shock", releaseYear: 1994 } },
  ]);

  assert.equal(resolved.sameWork, true);
  assert.deepEqual(resolved.names.map((n) => n.apiTitle), ["System Shock", "System Shock"]);
});

test("the year is what settles two films that really are called the same thing", () => {
  // Both TMDB records are titled Stalker; only one of them is from 1979.
  const resolved = resolveTitleYear(
    { key: "stalker|1979", title: "Stalker", releaseYear: 1979, refs: [] },
    [
      { apiRef: "tmdb__621300", ref: "621300", fresh: { englishTranslatedTitle: "Stalker", releaseYear: 2019 } },
      { apiRef: "tmdb__1398", ref: "1398", fresh: { englishTranslatedTitle: "Stalker", releaseYear: 1979 } },
    ]
  );

  assert.equal(resolved.sameWork, false);
});

test("a duration is printed, not counted — one game can honestly report two", () => {
  const resolved = resolveTitleYear(group, [
    { apiRef: "igdb__18375", ref: "18375", fresh: { englishTranslatedTitle: "System Shock", releaseYear: 1994, duration: 780 } },
    { apiRef: "igdb__23", ref: "23", fresh: { englishTranslatedTitle: "System Shock", releaseYear: 1994, duration: 810 } },
  ]);

  assert.equal(resolved.sameWork, true);
  assert.deepEqual(resolved.names.map((n) => n.duration), [780, 810]);
});

test("one answer settles nothing, and is not read as agreement", () => {
  const resolved = resolveTitleYear(group, [
    { apiRef: "igdb__880", ref: "880", fresh: { englishTranslatedTitle: "Resident Evil 2", releaseYear: 1998 } },
  ]);

  assert.equal(resolved.sameWork, undefined);
  assert.equal(resolved.names[0].apiTitle, "Resident Evil 2");
});

test("an id that could not be asked is reported with its error, not dropped", () => {
  const resolved = resolveTitleYear(group, [
    { apiRef: "igdb__18375", ref: "18375", fresh: { englishTranslatedTitle: "System Shock", releaseYear: 1994 } },
    { apiRef: "igdb__23", ref: "23", error: "429 Too Many Requests" },
  ]);

  assert.equal(resolved.sameWork, undefined);
  assert.equal(resolved.names[1].error, "429 Too Many Requests");
});

test("a disagreement anywhere in a trio is a disagreement", () => {
  const resolved = resolveTitleYear(
    { key: "mother|2009", title: "Mother", releaseYear: 2009, refs: [] },
    [
      { apiRef: "tmdb__37080", ref: "37080", fresh: { englishTranslatedTitle: "Mother", releaseYear: 2009 } },
      { apiRef: "tmdb__698885", ref: "698885", fresh: { englishTranslatedTitle: "Mother", releaseYear: 2009 } },
      { apiRef: "tmdb__30018", ref: "30018", fresh: { englishTranslatedTitle: "Mother", releaseYear: 2010 } },
    ]
  );

  assert.equal(resolved.sameWork, false);
});

test("two answers with no titles compared nothing", () => {
  assert.equal(freshWorksAgree({ releaseYear: 1994 }, { releaseYear: 1994 }), undefined);
  assert.equal(freshWorksAgree({ englishTranslatedTitle: "A" }, {}), undefined);
});

test("a missing year on one side is not a disagreement", () => {
  assert.equal(
    freshWorksAgree(
      { englishTranslatedTitle: "System Shock", releaseYear: 1994 },
      { englishTranslatedTitle: "System Shock" }
    ),
    true
  );
});
