const test = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const { retitleRefusalReason, retitleUpdate } = require("./work_retitle_plan");

const films = COLLECTIONS.find((c) => c.type === "films");
const games = COLLECTIONS.find((c) => c.type === "games");

/** A frozen film: the id is right, the stored spelling is not. #448. */
const duskTilDawn = {
  _id: "w1",
  entryType: "Film",
  englishTranslatedTitle: "From Dusk Til Dawn",
  apiRefs: ["tmdb__755"],
};
const answered = { englishTranslatedTitle: "From Dusk Till Dawn" };

test("a work is renamed to the title its own id answers with", () => {
  assert.equal(
    retitleRefusalReason({
      collection: films, work: duskTilDawn,
      retitleTo: "From Dusk Till Dawn", retrieved: answered,
    }),
    undefined
  );

  const { set, unset } = retitleUpdate(duskTilDawn, "From Dusk Till Dawn");
  assert.equal(set.englishTranslatedTitle, "From Dusk Till Dawn");
  assert.equal("originalTitle" in set, false);
  assert.equal(unset.metadataUpdatedDate, "");
});

test("the new title must be the answer, not merely agree with it", () => {
  // The whole guard. `Portal 2: Coop` against IGDB's `Portal 2` is the shape
  // ../work_ref_repair.js refuses, and it *agrees* under comparableTitle
  // because a trailing bracket and a colon-suffix both reduce away. Requiring
  // the string itself is what keeps this from being a free-text write.
  const reason = retitleRefusalReason({
    collection: games,
    work: { _id: "w", englishTranslatedTitle: "Portal", apiRefs: ["igdb__73"] },
    retitleTo: "Portal 2: Coop",
    retrieved: { englishTranslatedTitle: "Portal 2" },
  });
  assert.match(reason, /is not what igdb__73 names/);
});

test("a title nobody transcribed is refused before the API is asked", () => {
  for (const retitleTo of [undefined, "", "   "]) {
    assert.match(
      retitleRefusalReason({ collection: films, work: duskTilDawn, retitleTo }),
      /no retitleTo given/
    );
  }
});

test("a work with no identity ref has nothing to check against", () => {
  const reason = retitleRefusalReason({
    collection: films,
    work: { _id: "w", englishTranslatedTitle: "Something", apiRefs: [] },
    retitleTo: "Something Else",
    retrieved: { englishTranslatedTitle: "Something Else" },
  });
  assert.match(reason, /no tmdb__ ref to check a new title against/);
});

test("a placeholder ref is not an identity ref", () => {
  // 14 films carry `undefined__undefined` and 27 games `hltb__N/A`; treating
  // one as a ref would check the new title against nothing at all.
  const reason = retitleRefusalReason({
    collection: films,
    work: { _id: "w", englishTranslatedTitle: "Something", apiRefs: ["undefined__undefined"] },
    retitleTo: "Something Else",
    retrieved: { englishTranslatedTitle: "Something Else" },
  });
  assert.match(reason, /no tmdb__ ref to check a new title against/);
});

test("an unanswered id is a refusal, not an empty title to write", () => {
  assert.match(
    retitleRefusalReason({
      collection: films, work: duskTilDawn,
      retitleTo: "From Dusk Till Dawn", retrieveError: "HTTP 503",
    }),
    /could not be asked what it names \(HTTP 503\)/
  );
  assert.match(
    retitleRefusalReason({
      collection: films, work: duskTilDawn,
      retitleTo: "From Dusk Till Dawn", retrieved: {},
    }),
    /answered with no title/
  );
});

test("a work already carrying the answer is reported, not written", () => {
  assert.match(
    retitleRefusalReason({
      collection: films,
      work: { ...duskTilDawn, englishTranslatedTitle: "From Dusk Till Dawn" },
      retitleTo: "From Dusk Till Dawn",
      retrieved: answered,
    }),
    /already named/
  );
});

test("surrounding whitespace is not a difference", () => {
  assert.equal(
    retitleRefusalReason({
      collection: films, work: duskTilDawn,
      retitleTo: "  From Dusk Till Dawn  ",
      retrieved: { englishTranslatedTitle: "From Dusk Till Dawn" },
    }),
    undefined
  );
  assert.equal(
    retitleUpdate(duskTilDawn, "  From Dusk Till Dawn  ").set.englishTranslatedTitle,
    "From Dusk Till Dawn"
  );
});

test("the write names one field, and never an entry's", () => {
  // A person's own name for a work lives on their entry. Nothing reachable
  // from here may touch it — ../../docs/works_and_entries.md.
  const { set, unset } = retitleUpdate(duskTilDawn, "From Dusk Till Dawn");
  assert.deepEqual([...Object.keys(set)], ["englishTranslatedTitle"]);
  assert.deepEqual([...Object.keys(unset)], ["metadataUpdatedDate"]);
});
