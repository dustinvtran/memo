/**
 * @file The secondary-ref check, on works in a variable. Every case here is
 * one the database actually held in 2026-09.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sharedSecondaryRefs,
  describeSharedSecondaryRef,
} = require("./secondary_ref_check");

const games = { type: "games", identityPrefixes: ["igdb"] };
const books = { type: "books", identityPrefixes: ["ISBN", "google"] };

const work = (id, title, refs, releaseYear) => ({
  _id: id,
  englishTranslatedTitle: title,
  releaseYear,
  apiRefs: refs,
});

test("two works under one hltb id are a group", () => {
  const groups = sharedSecondaryRefs(games, [
    work(1, "System Shock", ["igdb__23", "hltb__9547"], 1994),
    work(2, "System Shock", ["igdb__18375", "hltb__9547"], 2023),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].ref, "hltb__9547");
  assert.deepEqual(groups[0].works.map((w) => w._id), [1, 2]);
});

/**
 * The reason this check did not already exist. 22 games carry `hltb__N/A` and
 * 13 films carry `undefined__undefined`; grouping on those would make the
 * loudest finding in the report the least real one.
 */
test("placeholders are not refs and never group", () => {
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      work(1, "A", ["igdb__1", "hltb__N/A"]),
      work(2, "B", ["igdb__2", "hltb__N/A"]),
      work(3, "C", ["undefined__undefined"]),
      work(4, "D", ["undefined__undefined"]),
    ]),
    []
  );
});

test("an identity ref shared by two works is somebody else's finding", () => {
  // shared_ref_check.js reports this one; reporting it twice would be worse
  // than not reporting it, because the two have different remedies.
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      work(1, "A", ["igdb__23"]),
      work(2, "B", ["igdb__23"]),
    ]),
    []
  );
});

test("a books group keys on neither of its two identity prefixes", () => {
  assert.deepEqual(
    sharedSecondaryRefs(books, [
      work(1, "A", ["ISBN__1", "google__1"]),
      work(2, "B", ["ISBN__1", "google__1"]),
    ]),
    []
  );
});

test("a ref only one work carries is not a group", () => {
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      work(1, "A", ["igdb__1", "hltb__5"]),
      work(2, "B", ["igdb__2", "hltb__6"]),
    ]),
    []
  );
});

/** One document holding the same ref twice is one holder of it, not two. */
test("a ref repeated inside one work is not a collision with itself", () => {
  assert.deepEqual(
    sharedSecondaryRefs(games, [work(1, "A", ["igdb__1", "hltb__5", "hltb__5"])]),
    []
  );
});

/**
 * `apiRefs` are flat strings with a few legacy `{ name, ref }` objects still
 * in them (CLAUDE.md). `parseApiRef` reads both, so a legacy one is a real ref
 * and two works sharing it is a real collision — the storage shape is not the
 * finding.
 */
test("a legacy object ref counts, and is keyed the same as a flat one", () => {
  const groups = sharedSecondaryRefs(games, [
    work(1, "A", [{ name: "hltb", ref: "5" }]),
    work(2, "B", ["hltb__5"]),
  ]);

  assert.deepEqual(groups.map((g) => g.ref), ["hltb__5"]);
});

test("junk in the array is stepped over rather than thrown on", () => {
  assert.deepEqual(
    sharedSecondaryRefs(games, [
      work(1, "A", [null, 7, "", "no-separator"]),
      work(2, "B", [null, 7, "", "no-separator"]),
      work(3, "C", undefined),
      null,
    ]),
    []
  );
});

test("groups come out sorted, so two runs can be diffed", () => {
  const groups = sharedSecondaryRefs(games, [
    work(1, "A", ["hltb__90"]),
    work(2, "B", ["hltb__90"]),
    work(3, "C", ["hltb__10"]),
    work(4, "D", ["hltb__10"]),
  ]);

  assert.deepEqual(groups.map((g) => g.ref), ["hltb__10", "hltb__90"]);
});

test("the line names the works, since a count is not actionable", () => {
  assert.equal(
    describeSharedSecondaryRef({
      ref: "hltb__69743",
      works: [
        work(1, "Dragon Age 4", [], 2024),
        work(2, "Dragon Quest V", [], 2004),
      ],
    }),
    "hltb__69743: Dragon Age 4 (2024), Dragon Quest V (2004)"
  );
});
