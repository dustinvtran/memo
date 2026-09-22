const test = require("node:test");
const assert = require("node:assert");
const {
  linkRefusalReason,
  siblingsAfterRun,
  deleteRefusalReason,
  linkUpdate,
  nameAfter,
  overrideIsRedundant,
  workTitleRefusalReason,
  workTitleUpdate,
} = require("./entry_link_plan");

const games = { type: "games", retrievePrefix: "igdb" };
const films = { type: "films", retrievePrefix: "tmdb" };

/** A work that can be moved onto: it has an id of its own. */
const nioh = { _id: "w1", englishTranslatedTitle: "Nioh", apiRefs: ["igdb__12571"] };
const entry = { _id: "e1", overrides: { releaseYear: 2017 } };

test("an entry that isn't there is the first thing refused", () => {
  assert.equal(linkRefusalReason({ entry: null, collection: games }), "no entry with that id");
  assert.equal(deleteRefusalReason({ entry: undefined }), "no entry with that id");
});

test("a placeholder is not an id", () => {
  const why = linkRefusalReason({ entry, ref: "hltb__N/A", collection: games });
  assert.match(why, /not a usable ref/);
});

test("a ref of the wrong type is refused before anything is retrieved", () => {
  const why = linkRefusalReason({ entry, ref: "tmdb__550", collection: games });
  assert.match(why, /retrieved by igdb__, not tmdb__/);
});

const curbHolders = [
  { _id: "a", englishTranslatedTitle: "Curb Your Enthusiasm", apiRefs: ["tmdb__4546"] },
  { _id: "b", englishTranslatedTitle: "Curb - Season 10", apiRefs: ["tmdb__4546"] },
];

test("two works already under the id is #290, and this does not pick a side", () => {
  const why = linkRefusalReason({
    entry,
    ref: "tmdb__4546",
    collection: films,
    holders: curbHolders,
  });
  assert.match(why, /say which with toWork/);
});

/**
 * The collision is real and pre-existing; naming the work is how a person
 * says which side of it they mean, and refusing then would refuse a repair
 * for the sake of something it does not touch.
 */
test("naming the work outright is allowed even while the id is shared", () => {
  const why = linkRefusalReason({
    entry,
    work: curbHolders[0],
    ref: "tmdb__4546",
    collection: films,
    entryTitle: "Curb Your Enthusiasm: Season 9",
    holders: curbHolders,
    siblings: [],
  });
  assert.equal(why, undefined);
});

test("one holder is the ordinary case and is not refused", () => {
  const why = linkRefusalReason({
    entry,
    ref: "igdb__12571",
    collection: games,
    holders: [nioh],
    work: nioh,
    siblings: [],
    entryTitle: "Nioh: Dragon of the North",
  });
  assert.equal(why, undefined);
});

test("moving onto a work with no id of its own fixes nothing", () => {
  const orphan = { _id: "w2", englishTranslatedTitle: "Portal 2: Coop", apiRefs: [] };
  const why = linkRefusalReason({ entry, work: orphan, collection: games, siblings: [] });
  assert.match(why, /has no igdb__ ref of its own/);
});

test("a placeholder on the target work does not count as an id", () => {
  const placeholder = { _id: "w3", englishTranslatedTitle: "Doom", apiRefs: ["hltb__2701"] };
  const why = linkRefusalReason({ entry, work: placeholder, collection: games, siblings: [] });
  assert.match(why, /has no igdb__ ref of its own/);
});

test("two entries on one work must differ in the name they are filed under", () => {
  const why = linkRefusalReason({
    entry,
    work: nioh,
    collection: games,
    siblings: [{ _id: "e2" }],
  });
  assert.match(why, /already has an entry filed as the work's own title/);
});

test("a sibling under a different name is not a clash", () => {
  const why = linkRefusalReason({
    entry,
    work: nioh,
    collection: games,
    entryTitle: "Nioh: Dragon of the North",
    siblings: [{ _id: "e2", overrides: { englishTranslatedTitle: "Nioh" } }],
  });
  assert.equal(why, undefined);
});

test("the entry being moved is not its own sibling", () => {
  const titled = { _id: "e1", overrides: { englishTranslatedTitle: "Season 9" } };
  const why = linkRefusalReason({
    entry: titled,
    work: nioh,
    collection: games,
    entryTitle: "Season 9",
    siblings: [titled],
  });
  assert.equal(why, undefined);
});

test("a blank override and a missing one are the same name", () => {
  assert.equal(nameAfter({ overrides: { englishTranslatedTitle: "   " } }, undefined), null);
  assert.equal(nameAfter({}, ""), null);
  assert.equal(nameAfter({}, " Portal 2: Coop "), "Portal 2: Coop");

  const why = linkRefusalReason({
    entry,
    work: nioh,
    collection: games,
    entryTitle: "  ",
    siblings: [{ _id: "e2", overrides: { englishTranslatedTitle: "" } }],
  });
  assert.match(why, /already has an entry filed as the work's own title/);
});

// --- the names the run itself has assigned ---

/**
 * The Castlevania repair from #381, which is what found this. Three entries on
 * one show: one is renamed off `Castlevania: Season 2` and the next moves in to
 * take the name it has just left. On an `--apply` the first write is in the
 * database by the time the second operation reads the siblings, so both go
 * through; the dry run read both against the database and refused the second.
 * #386.
 */
const castlevania = { _id: "w9", englishTranslatedTitle: "Castlevania", apiRefs: ["tmdb__71535"] };
const dropped = {
  _id: "e-dropped",
  userId: "u1",
  workRef: "w9",
  overrides: { englishTranslatedTitle: "Castlevania: Season 2" },
};
const stray = { _id: "e-stray", userId: "u1", workRef: "w8", overrides: { englishTranslatedTitle: "S2" } };

/** The run having performed one operation: the entry as it leaves it. */
const after = (entry, { workRef, filedAs }) => [
  String(entry._id),
  { ...entry, workRef, overrides: { ...entry.overrides, englishTranslatedTitle: filedAs } },
];

test("a name an earlier operation freed is free", () => {
  const move = {
    entry: stray,
    work: castlevania,
    collection: films,
    entryTitle: "Castlevania: Season 2",
  };
  // What the database says, which is the state before the run started.
  assert.match(
    linkRefusalReason({ ...move, siblings: [dropped] }),
    /already has an entry filed as "Castlevania: Season 2"/
  );

  const assigned = new Map([after(dropped, { workRef: "w9", filedAs: "Castlevania: Season 3" })]);
  const siblings = siblingsAfterRun({ siblings: [dropped], workId: "w9", userId: "u1", assigned });
  assert.equal(linkRefusalReason({ ...move, siblings }), undefined);
});

/** The other way off a name: the entry is still called that, elsewhere. */
test("an entry the run has moved away is not on this work any more", () => {
  const assigned = new Map([after(dropped, { workRef: "w7", filedAs: "Castlevania: Season 2" })]);
  assert.deepEqual(
    siblingsAfterRun({ siblings: [dropped], workId: "w9", userId: "u1", assigned }),
    []
  );
});

/**
 * The same blindness pointing the other way, and fixed by the same fold: a
 * clash the run creates is one the apply would refuse, so inventing a pass here
 * is the failure that inventing a refusal was.
 */
test("a name an earlier operation took is taken, which the database cannot say either", () => {
  const assigned = new Map([after(stray, { workRef: "w9", filedAs: "Castlevania: Season 2" })]);
  const siblings = siblingsAfterRun({ siblings: [], workId: "w9", userId: "u1", assigned });
  assert.match(
    linkRefusalReason({
      entry: { _id: "e-third", userId: "u1" },
      work: castlevania,
      collection: films,
      entryTitle: "Castlevania: Season 2",
      siblings,
    }),
    /already has an entry filed as "Castlevania: Season 2" \(e-stray\)/
  );
});

/**
 * On an `--apply` the database has already answered with the row the run
 * wrote. Keyed by entry id, folding it in replaces that row with itself —
 * which is why this needs no equivalent of `createdThisRun`'s re-read.
 */
test("the apply's own write is not counted twice", () => {
  const [id, renamed] = after(dropped, { workRef: "w9", filedAs: "Castlevania: Season 3" });
  const siblings = siblingsAfterRun({
    siblings: [renamed],
    workId: "w9",
    userId: "u1",
    assigned: new Map([[id, renamed]]),
  });
  assert.deepEqual(siblings, [renamed]);
});

/** The sibling read is filtered by owner, and so is this. */
test("another person's entry does not take a name on this one's work", () => {
  const theirs = { ...dropped, _id: "e-other", userId: "u2" };
  assert.deepEqual(
    siblingsAfterRun({ siblings: [], workId: "w9", userId: "u1", assigned: new Map([["e-other", theirs]]) }),
    []
  );
});

test("a link whose work is yet to be created has nothing to be a sibling on", () => {
  const assigned = new Map([after(dropped, { workRef: "w9", filedAs: "Castlevania: Season 2" })]);
  assert.deepEqual(siblingsAfterRun({ siblings: [], workId: undefined, userId: "u1", assigned }), []);
});

test("the write sets the workRef and merges the override", () => {
  const { set, unset } = linkUpdate({ entry, workId: "w1", entryTitle: "Nioh: DLCs" });
  assert.deepEqual(set, {
    workRef: "w1",
    "overrides.englishTranslatedTitle": "Nioh: DLCs",
  });
  assert.deepEqual(unset, {});
});

test("dotted paths, so the rest of the overrides survive the write", () => {
  const { set } = linkUpdate({ entry, workId: "w1", entryTitle: "x" });
  assert.ok(!("overrides" in set), "a whole-object set would drop releaseYear");
});

/**
 * The bug the first dry run found: eight entries whose only record of their
 * own title is this override, reported as attached and quietly renamed.
 */
test("leaving entryTitle out does not touch the override", () => {
  const titled = { _id: "e1", overrides: { englishTranslatedTitle: "Doom Eternal: KaiserCampaign" } };
  const { set, unset } = linkUpdate({ entry: titled, workId: "w1" });
  assert.deepEqual(set, { workRef: "w1" });
  assert.deepEqual(unset, {});
});

test("an emptied entryTitle unsets the override rather than blanking it", () => {
  const titled = { _id: "e1", overrides: { englishTranslatedTitle: "Season 9" } };
  const { set, unset } = linkUpdate({ entry: titled, workId: "w1", entryTitle: "" });
  assert.deepEqual(set, { workRef: "w1" });
  assert.deepEqual(unset, { "overrides.englishTranslatedTitle": "" });
});

test("no override to begin with and none asked for is not an unset", () => {
  const { unset } = linkUpdate({ entry, workId: "w1", entryTitle: "" });
  assert.deepEqual(unset, {});
});

test("a delete only ever takes the work when the entry is its last", () => {
  assert.equal(deleteRefusalReason({ entry, otherEntries: [] }), undefined);
  assert.match(
    deleteRefusalReason({ entry, otherEntries: [{ _id: "e2" }] }),
    /still has 1 other entry/
  );
  assert.match(
    deleteRefusalReason({ entry, otherEntries: [{ _id: "e2" }, { _id: "e3" }] }),
    /still has 2 other entries/
  );
});

test("an override saying what the work says is redundant, whatever the punctuation", () => {
  const work = { englishTranslatedTitle: "Doom Eternal KaiserCampaign" };
  assert.equal(
    overrideIsRedundant({ overrides: { englishTranslatedTitle: "Doom Eternal: KaiserCampaign" } }, work),
    true
  );
});

test("a season name is not redundant, which is the point of having it", () => {
  assert.equal(
    overrideIsRedundant(
      { overrides: { englishTranslatedTitle: "Curb Your Enthusiasm: Season 9" } },
      { englishTranslatedTitle: "Curb Your Enthusiasm" }
    ),
    false
  );
});

test("an entry with no override of its own has nothing to be redundant", () => {
  assert.equal(overrideIsRedundant({}, { englishTranslatedTitle: "Nioh" }), false);
});

// --- giving a work back the API's own title ---

const why = (args) => workTitleRefusalReason(args);
const named = (title, apiRefs = ["tmdb__1"]) => ({ _id: "w1", englishTranslatedTitle: title, apiRefs });

/**
 * #381. `Ozark: Season 4` under Ozark's id is not damaged — it is named by its
 * owner rather than by TMDB — but the title guard freezes it, so it has not
 * refreshed since it was stored. The repair is to let the work be the API's
 * copy and put the owner's name on the entry.
 */
test("the API's own title is allowed when the entry keeps the owner's name", () => {
  assert.equal(
    why({
      work: named("Ozark: Season 4"),
      workTitle: "Ozark",
      entryTitle: "Ozark: Season 4",
      retrieved: { englishTranslatedTitle: "Ozark" },
    }),
    undefined
  );
});

/** The dangerous half on its own: a refresh bought by losing the name. */
test("renaming without giving the entry the name is refused", () => {
  const reason = why({
    work: named("Ozark: Season 4"),
    workTitle: "Ozark",
    retrieved: { englishTranslatedTitle: "Ozark" },
  });
  assert.match(reason, /written down nowhere/);
  assert.match(reason, /entryTitle/);
});

/**
 * The three-valued `entryTitle` again, and the distinction is the guard:
 * absent means nobody considered the old name, empty means somebody did and
 * said to drop it. `The Witcher` under The Witcher IV's id is the second —
 * the id is right and the name is merely stale.
 */
test("an empty entryTitle is consent to drop the old name, not an oversight", () => {
  assert.equal(
    why({
      work: named("The Witcher"),
      workTitle: "The Witcher IV",
      entryTitle: "",
      retrieved: { englishTranslatedTitle: "The Witcher IV" },
    }),
    undefined
  );
});

test("an absent entryTitle is refused, and says how to drop the name on purpose", () => {
  const reason = why({
    work: named("House M.D."),
    workTitle: "House",
    retrieved: { englishTranslatedTitle: "House" },
  });
  assert.match(reason, /written down nowhere/);
  assert.match(reason, /pass "" to drop it/);
});

/** A work already called what the API calls it loses nothing by being told so. */
test("a work whose title already matches needs no entryTitle", () => {
  assert.equal(
    why({
      work: named("Ozark"),
      workTitle: "Ozark",
      retrieved: { englishTranslatedTitle: "Ozark" },
    }),
    undefined
  );
});

/** The same evidence rule as retitleWorkTo: a guess is refused. */
test("a workTitle that is not what the API answers with is refused", () => {
  assert.match(
    why({
      work: named("Ozark: Season 4"),
      workTitle: "Ozarks",
      entryTitle: "Ozark: Season 4",
      retrieved: { englishTranslatedTitle: "Ozark" },
    }),
    /is not what the API answers with/
  );
});

test("an unchecked workTitle is refused rather than trusted", () => {
  assert.match(
    why({ work: named("A"), workTitle: "B", entryTitle: "A", retrieveError: "404" }),
    /unchecked/
  );
  assert.match(why({ work: named("A"), workTitle: "B", entryTitle: "A" }), /unchecked/);
});

test("an empty workTitle is refused rather than blanking the work", () => {
  assert.match(
    why({ work: named("A"), workTitle: "  ", entryTitle: "A", retrieved: { englishTranslatedTitle: "B" } }),
    /workTitle is empty/
  );
});

/**
 * The refresh is the entire point, so the work must stop looking checked.
 * It has been frozen for as long as it has been named this way.
 */
test("the write takes the API's spelling and unfreezes the work", () => {
  const { set, unset } = workTitleUpdate({ englishTranslatedTitle: "MINDHUNTER" });
  assert.equal(set.englishTranslatedTitle, "MINDHUNTER");
  assert.equal("metadataUpdatedDate" in unset, true);
  // originalTitle is fill-only, and the refresh this unblocks is what fills it.
  assert.equal("originalTitle" in set, false);
});

// --- the rule itself, asserted on the writes these functions produce ---

/**
 * `docs/works_and_entries.md`. A work is the database's copy of what an API
 * says; what a person types lives on their entry. The two functions in this
 * module are the only ones here that write, so between them they are where
 * that rule is either kept or lost.
 */
test("linking an entry writes nothing that belongs to a work", () => {
  const { set, unset } = linkUpdate({
    entry: { _id: "e1", overrides: { englishTranslatedTitle: "Ozark: Season 4" } },
    workId: "w1",
    entryTitle: "Ozark: Season 4",
  });
  // A work's identity above all: renaming a row must never be able to
  // re-point it at something else.
  for (const field of ["apiRefs", "englishTranslatedTitle", "releaseYear", "duration", "genres", "metadataUpdatedDate"]) {
    assert.equal(field in set, false, `${field} is a work's, and must not be in an entry write`);
    assert.equal(field in unset, false, `${field} is a work's, and must not be unset on an entry`);
  }
  assert.equal(set.workRef, "w1");
  assert.equal(set["overrides.englishTranslatedTitle"], "Ozark: Season 4");
});

/** And the other direction: the work write touches nothing of the entry's. */
test("renaming a work writes nothing that belongs to an entry", () => {
  const { set, unset } = workTitleUpdate({ englishTranslatedTitle: "Ozark", releaseYear: 2017 });
  for (const field of ["overrides", "status", "score", "startedDate", "completedDate", "workRef", "userId"]) {
    assert.equal(field in set, false, `${field} is an entry's, and must not be in a work write`);
    assert.equal(field in unset, false, `${field} is an entry's, and must not be unset on a work`);
  }
  // A work's identity is not the title's to change either: `workTitle` moves a
  // work back to the API's name for the id it already has, never to a new id.
  assert.equal("apiRefs" in set, false);
});

