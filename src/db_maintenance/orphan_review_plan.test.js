const { test } = require("node:test");
const assert = require("node:assert/strict");

const { planOrphanReviewRemoval, hasText } = require("./orphan_review_plan");

const entry = (id) => ({ _id: id, userId: "u1" });
const review = (id, entryRef, text) => ({ _id: id, entryRef, ...(text === undefined ? {} : { text }) });

test("a review whose entry is gone is orphaned; one whose entry is there is not", () => {
  const plan = planOrphanReviewRemoval(
    [entry("e1"), entry("e2")],
    [review("r1", "e1", "kept"), review("r2", "gone", "orphan"), review("r3", "e2")]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.orphans.map((r) => r._id), ["r2"]);
  assert.equal(plan.keptCount, 2);
});

test("no entries at all is refused rather than planned", () => {
  const plan = planOrphanReviewRemoval([], [review("r1", "e1", "text")]);

  assert.match(plan.blocked, /refusing/);
  assert.deepEqual(plan.orphans, []);
});

test("no entries and no reviews is not a failure, just nothing to do", () => {
  const plan = planOrphanReviewRemoval([], []);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.orphans, []);
});

test("a review carrying no entryRef is orphaned, and never matched to an entry by accident", () => {
  const plan = planOrphanReviewRemoval(
    [entry("undefined"), entry("null")],
    [review("r1", undefined, "x"), review("r2", null, "y")]
  );

  assert.deepEqual(plan.orphans.map((r) => r._id), ["r1", "r2"]);
});

test("ids are compared as strings, so a numeric ref still matches its entry", () => {
  const plan = planOrphanReviewRemoval([entry("322682678")], [review("r1", 322682678, "x")]);

  assert.deepEqual(plan.orphans, []);
  assert.equal(plan.keptCount, 1);
});

test("orphans are split by whether anyone actually wrote anything", () => {
  const plan = planOrphanReviewRemoval(
    [entry("e1")],
    [review("r1", "gone", "a note"), review("r2", "gone", ""), review("r3", "gone")]
  );

  assert.deepEqual(plan.withText.map((r) => r._id), ["r1"]);
  assert.deepEqual(plan.empty.map((r) => r._id), ["r2", "r3"]);
  assert.equal(plan.orphans.length, 3);
});

test("nothing is planned for removal when every review still has its entry", () => {
  const plan = planOrphanReviewRemoval(
    [entry("e1"), entry("e2")],
    [review("r1", "e1", "x"), review("r2", "e2", "y")]
  );

  assert.deepEqual(plan.orphans, []);
  assert.equal(plan.keptCount, 2);
});

test("a non-array argument is refused, not coerced", () => {
  assert.match(planOrphanReviewRemoval(undefined, []).blocked, /must both be arrays/);
  assert.match(planOrphanReviewRemoval([], null).blocked, /must both be arrays/);
});

test("hasText is about there being writing, not about the field existing", () => {
  assert.equal(hasText({ text: "words" }), true);
  assert.equal(hasText({ text: "" }), false);
  assert.equal(hasText({}), false);
  assert.equal(hasText({ text: null }), false);
  assert.equal(hasText(undefined), false);
});

test("re-running over the result of a run finds nothing left to do", () => {
  const entries = [entry("e1")];
  const reviews = [review("r1", "e1", "kept"), review("r2", "gone", "orphan")];

  const first = planOrphanReviewRemoval(entries, reviews);
  const removed = new Set(first.orphans.map((r) => r._id));
  const after = reviews.filter((r) => !removed.has(r._id));

  assert.deepEqual(planOrphanReviewRemoval(entries, after).orphans, []);
});
