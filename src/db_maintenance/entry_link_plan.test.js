const test = require("node:test");
const assert = require("node:assert");
const {
  linkRefusalReason,
  deleteRefusalReason,
  linkUpdate,
  nameAfter,
  overrideIsRedundant,
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
