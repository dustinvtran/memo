const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  planUnreachableWorks,
  planEmptyReviewRemoval,
} = require("./unreachable_document_plan");

const work = (id, rest = {}) => ({ _id: id, ...rest });
const entry = (id, workRef) => ({ _id: id, userId: "u1", workRef });
const review = (id, entryRef, text) => ({
  _id: id,
  entryRef,
  ...(text === undefined ? {} : { text }),
});

/** Four non-empty entry collections, which is what the guard below demands. */
const populated = (overrides = {}) => ({
  filmEntries: [entry("fe1", "f1")],
  tvShowEntries: [entry("te1", "t1")],
  gameEntries: [entry("ge1", "g1")],
  bookEntries: [entry("be1", "b1")],
  ...overrides,
});

///////////////////////////////////////////////////////////////////////////////
// Works

test("a work no entry names is deletable; one an entry names is not", () => {
  const plan = planUnreachableWorks({
    works: [work("f1"), work("f2"), work("f3")],
    entriesByCollection: populated({
      filmEntries: [entry("fe1", "f1"), entry("fe2", "f3")],
    }),
    ownEntryCollection: "filmEntries",
  });

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(
    plan.deletable.map((w) => w._id),
    ["f2"]
  );
  assert.equal(plan.reachable, 2);
  assert.deepEqual(plan.skipped, []);
});

test("an entry in another type's collection is enough to spare a work", () => {
  const plan = planUnreachableWorks({
    works: [work("f1"), work("f2")],
    entriesByCollection: populated({
      filmEntries: [entry("fe1", "f1")],
      // The schema does not stop this, so neither may the plan.
      bookEntries: [entry("be1", "b1"), entry("be2", "f2")],
    }),
    ownEntryCollection: "filmEntries",
  });

  assert.deepEqual(plan.deletable, []);
  assert.deepEqual(
    plan.crossCollection.map((w) => w._id),
    ["f2"]
  );
});

test("crossCollection is the works only a foreign collection reaches, and nothing else", () => {
  const plan = planUnreachableWorks({
    works: [work("f1")],
    entriesByCollection: populated({
      filmEntries: [entry("fe1", "f1")],
      bookEntries: [entry("be1", "b1"), entry("be2", "f1")],
    }),
    ownEntryCollection: "filmEntries",
  });

  // Reached by both, so its own collection accounts for it.
  assert.deepEqual(plan.crossCollection, []);
  assert.equal(plan.reachable, 1);
});

test("a work in an open collision group is skipped, with the reason that objected", () => {
  const plan = planUnreachableWorks({
    works: [work("f1"), work("f2"), work("f3")],
    entriesByCollection: populated({ filmEntries: [entry("fe1", "f1")] }),
    ownEntryCollection: "filmEntries",
    protectedWorkIds: [{ id: "f2", reason: "same title and year as f1" }],
  });

  assert.deepEqual(
    plan.deletable.map((w) => w._id),
    ["f3"]
  );
  assert.deepEqual(plan.skipped, [
    { work: work("f2"), reason: "same title and year as f1" },
  ]);
  // Still counted as unreachable: the skip is a refusal to act, not a claim
  // that something points at it.
  assert.equal(plan.unreachable.length, 2);
});

test("an entry collection that came back empty is refused rather than planned", () => {
  const plan = planUnreachableWorks({
    works: [work("f1"), work("f2")],
    entriesByCollection: populated({ gameEntries: [] }),
    ownEntryCollection: "filmEntries",
  });

  assert.match(plan.blocked, /gameEntries came back empty/);
  assert.deepEqual(plan.deletable, []);
});

test("a collection in which nothing at all is reachable is refused", () => {
  const plan = planUnreachableWorks({
    // Every entry list is populated; none of them names either of these,
    // which is what a `workRef` read under the wrong name looks like.
    works: [work("x1"), work("x2")],
    entriesByCollection: populated(),
    ownEntryCollection: "filmEntries",
  });

  assert.match(plan.blocked, /all 2 work\(s\) look unreachable/);
  assert.deepEqual(plan.deletable, []);
});

test("no works at all is not a failure, just nothing to do", () => {
  const plan = planUnreachableWorks({
    works: [],
    entriesByCollection: populated(),
    ownEntryCollection: "filmEntries",
  });

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.deletable, []);
});

test("no entry collections at all is refused", () => {
  const plan = planUnreachableWorks({
    works: [work("f1")],
    entriesByCollection: {},
  });

  assert.match(plan.blocked, /no entry collections/);
});

test("an entry with no workRef references nothing, and never spares a work by accident", () => {
  const plan = planUnreachableWorks({
    works: [work("undefined"), work("null"), work("f1")],
    entriesByCollection: populated({
      filmEntries: [
        entry("fe1", "f1"),
        // The 23 user-authored entries carry no workRef at all.
        entry("fe2", undefined),
        entry("fe3", null),
      ],
    }),
    ownEntryCollection: "filmEntries",
  });

  assert.deepEqual(
    plan.deletable.map((w) => w._id),
    ["undefined", "null"]
  );
});

///////////////////////////////////////////////////////////////////////////////
// Reviews

test("an empty review whose entry is there is deletable; one holding text is not", () => {
  const plan = planEmptyReviewRemoval(
    [entry("e1"), entry("e2"), entry("e3")],
    [
      review("r1", "e1", ""),
      review("r2", "e2", "a note"),
      review("r3", "e3"),
    ]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(
    plan.deletable.map((r) => r._id),
    // A review with no `text` field at all holds nothing either.
    ["r1", "r3"]
  );
  assert.deepEqual(
    plan.withText.map((r) => r._id),
    ["r2"]
  );
});

test("an empty review whose entry is gone is left to prune_orphan_reviews.js", () => {
  const plan = planEmptyReviewRemoval(
    [entry("e1")],
    [review("r1", "e1", ""), review("r2", "gone", ""), review("r3", "gone", "x")]
  );

  assert.deepEqual(
    plan.deletable.map((r) => r._id),
    ["r1"]
  );
  assert.deepEqual(
    plan.orphaned.map((r) => r._id),
    ["r2", "r3"]
  );
});

test("a review carrying no entryRef is orphaned, not emptied", () => {
  const plan = planEmptyReviewRemoval(
    [entry("undefined"), entry("null")],
    [review("r1", undefined, ""), review("r2", null, "")]
  );

  assert.deepEqual(plan.deletable, []);
  assert.deepEqual(
    plan.orphaned.map((r) => r._id),
    ["r1", "r2"]
  );
});

test("whitespace is text: only the empty string is empty", () => {
  const plan = planEmptyReviewRemoval(
    [entry("e1"), entry("e2")],
    [review("r1", "e1", " "), review("r2", "e2", "\n")]
  );

  assert.deepEqual(plan.deletable, []);
  assert.equal(plan.withText.length, 2);
});

test("no entries at all is refused rather than planned", () => {
  const plan = planEmptyReviewRemoval([], [review("r1", "e1", "")]);

  assert.match(plan.blocked, /refusing/);
  assert.deepEqual(plan.deletable, []);
});

test("no reviews at all is not a failure, just nothing to do", () => {
  const plan = planEmptyReviewRemoval([], []);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.deletable, []);
});
