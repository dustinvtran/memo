const { test } = require("node:test");
const assert = require("node:assert/strict");

const { planDeadFieldRemoval, DEAD_FIELDS } = require("./dead_entry_fields_plan");

const entry = (id, fields = {}) => ({ _id: id, userId: "u1", ...fields });
const review = (entryRef, text) => ({
  _id: `r-${entryRef}`,
  entryRef,
  ...(text === undefined ? {} : { text }),
});

const ids = (plan, field) => plan[field].ids;

test("a note that is verbatim in the reviews collection may be dropped", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "the note" })],
    [review("e1", "the note")]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(ids(plan, "review"), ["e1"]);
  assert.deepEqual(plan.mismatches, []);
});

test("a note the reviews collection does not have is refused, and so is the rest of that entry", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "somebody's writing", commonMetadata: { title: "x" } })],
    [review("other", "unrelated")]
  );

  // Both fields, not just the note: a document we cannot account for is not
  // one to write to.
  assert.deepEqual(ids(plan, "review"), []);
  assert.deepEqual(ids(plan, "commonMetadata"), []);
  assert.equal(plan.totals.skipped, 1);
  assert.equal(plan.mismatches.length, 1);
  assert.equal(plan.mismatches[0].reason, "no review document");
  assert.equal(plan.mismatches[0].entryChars, "somebody's writing".length);
});

test("a note that differs from the stored one is refused, and reported with both sizes", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "the fuller draft" })],
    [review("e1", "a draft")]
  );

  assert.deepEqual(ids(plan, "review"), []);
  assert.equal(plan.mismatches[0].reason, "review document holds different text");
  assert.equal(plan.mismatches[0].entryChars, "the fuller draft".length);
  assert.equal(plan.mismatches[0].storedChars, "a draft".length);
});

test("verification is equality, not existence — a near-miss is a mismatch", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "the note" })],
    [review("e1", "the note ")]
  );

  assert.deepEqual(ids(plan, "review"), []);
  assert.equal(plan.mismatches.length, 1);
});

test("an entry with two review documents is verified by whichever one matches", () => {
  // Nothing in the schema says an entry has one review, and picking the first
  // would refuse an entry whose note is sitting right there in the second.
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "the note" })],
    [review("e1", "an older copy"), review("e1", "the note")]
  );

  assert.deepEqual(ids(plan, "review"), ["e1"]);
});

test("an empty note is verified against an empty stored one", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "" })],
    [review("e1", "")]
  );

  assert.deepEqual(ids(plan, "review"), ["e1"]);
});

test("an empty note beside a review document with no text at all is refused", () => {
  // They read the same on a page and differently in `toSnapshot`, which drops
  // an undefined field from a revision rather than recording it as empty.
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "" })],
    [review("e1", undefined)]
  );

  assert.deepEqual(ids(plan, "review"), []);
  assert.equal(plan.mismatches[0].reason, "review document holds different text");
});

test("commonMetadata needs no verification — nothing reads it, so it always goes", () => {
  const plan = planDeadFieldRemoval(
    [
      entry("e1", { commonMetadata: { englishTranslatedTitle: "stale" } }),
      entry("e2", { commonMetadata: null }),
      entry("e3"),
    ],
    []
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(ids(plan, "commonMetadata"), ["e1", "e2"]);
  assert.equal(plan.commonMetadata.objects, 1);
  assert.equal(plan.commonMetadata.nulls, 1);
});

test("a hand-typed entry with no workRef is no exception", () => {
  // The read path overwrites `commonMetadata` with the `$lookup` result
  // whether or not the lookup found anything, so these 23 render from
  // `overrides` over the empty stand-in either way.
  const plan = planDeadFieldRemoval(
    [entry("e1", { commonMetadata: { title: "typed in by hand" }, overrides: { title: "t" } })],
    []
  );

  assert.deepEqual(ids(plan, "commonMetadata"), ["e1"]);
});

test("presence and not truthiness: a field holding null is still a field being stored", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: null, commonMetadata: null })],
    [review("e1", null)]
  );

  assert.deepEqual(ids(plan, "review"), ["e1"]);
  assert.deepEqual(ids(plan, "commonMetadata"), ["e1"]);
});

test("an entry carrying neither field is left out of the plan entirely", () => {
  const plan = planDeadFieldRemoval([entry("e1"), entry("e2")], []);

  assert.deepEqual(ids(plan, "review"), []);
  assert.deepEqual(ids(plan, "commonMetadata"), []);
  assert.equal(plan.totals.entries, 2);
  assert.equal(plan.totals.carryingReview, 0);
  assert.equal(plan.totals.carryingCommonMetadata, 0);
});

test("notes but no reviews at all is refused rather than planned", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "a note", commonMetadata: null })],
    []
  );

  assert.match(plan.blocked, /failed collection read/);
  assert.deepEqual(ids(plan, "review"), []);
  // Nothing is planned when the read is in doubt, not even the safe half.
  assert.deepEqual(ids(plan, "commonMetadata"), []);
});

test("no reviews and no notes is not a failure, just nothing to verify", () => {
  const plan = planDeadFieldRemoval([entry("e1", { commonMetadata: null })], []);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(ids(plan, "commonMetadata"), ["e1"]);
});

test("a review filed under no entry at all never verifies one by accident", () => {
  // Without this an entry whose `_id` stringifies to "undefined" would be
  // matched by a review carrying no `entryRef`.
  const plan = planDeadFieldRemoval(
    [entry("undefined", { review: "a note" })],
    [review(undefined, "a note"), review(null, "a note")]
  );

  assert.deepEqual(ids(plan, "review"), []);
  assert.equal(plan.mismatches[0].reason, "no review document");
});

test("an id compares as an id, whatever type it arrives as", () => {
  // Fauna-era ids are numeric strings in some documents and numbers in
  // others; comparing them raw would refuse a perfectly verified note.
  const plan = planDeadFieldRemoval(
    [entry(1234, { review: "a note" })],
    [review("1234", "a note")]
  );

  assert.deepEqual(ids(plan, "review"), [1234]);
});

test("--fields restricts what is planned without changing what is verified", () => {
  const entries = [
    entry("e1", { review: "the note", commonMetadata: null }),
    entry("e2", { review: "unverifiable", commonMetadata: null }),
  ];
  const reviews = [review("e1", "the note")];

  const metadataOnly = planDeadFieldRemoval(entries, reviews, ["commonMetadata"]);

  assert.deepEqual(ids(metadataOnly, "review"), []);
  // e2 is still skipped whole: the note it carries is still unaccounted for.
  assert.deepEqual(ids(metadataOnly, "commonMetadata"), ["e1"]);
  assert.equal(metadataOnly.mismatches.length, 1);

  const notesOnly = planDeadFieldRemoval(entries, reviews, ["review"]);

  assert.deepEqual(ids(notesOnly, "review"), ["e1"]);
  assert.deepEqual(ids(notesOnly, "commonMetadata"), []);
});

test("a field that is not one of the dead ones is refused, not quietly unset", () => {
  const plan = planDeadFieldRemoval(
    [entry("e1", { overrides: { title: "x" } })],
    [],
    ["overrides"]
  );

  assert.match(plan.blocked, /not a dead field: overrides/);
});

test("anything other than two arrays is refused", () => {
  assert.match(planDeadFieldRemoval(undefined, []).blocked, /must both be arrays/);
  assert.match(planDeadFieldRemoval([], undefined).blocked, /must both be arrays/);
});

test("the plan is built fresh, so one call cannot leak into the next", () => {
  const first = planDeadFieldRemoval([entry("e1", { commonMetadata: null })], []);
  first.review.ids.push("not from here");
  first.mismatches.push("nor this");

  const second = planDeadFieldRemoval([entry("e2", { commonMetadata: null })], []);

  assert.deepEqual(ids(second, "review"), []);
  assert.deepEqual(second.mismatches, []);
  assert.deepEqual(ids(second, "commonMetadata"), ["e2"]);
});

test("a blocked plan is built fresh too", () => {
  const first = planDeadFieldRemoval(undefined, []);
  first.review.ids.push("not from here");

  assert.deepEqual(ids(planDeadFieldRemoval(undefined, []), "review"), []);
});

test("the sizes reported are the sizes of what would go", () => {
  const stale = { englishTranslatedTitle: "a stale copy of the work" };
  const plan = planDeadFieldRemoval(
    [entry("e1", { review: "note", commonMetadata: stale })],
    [review("e1", "note")]
  );

  assert.equal(plan.review.jsonChars, JSON.stringify("note").length);
  assert.equal(plan.commonMetadata.jsonChars, JSON.stringify(stale).length);
});

test("the dead fields are the two the API does not read", () => {
  assert.deepEqual(DEAD_FIELDS, ["review", "commonMetadata"]);
});
