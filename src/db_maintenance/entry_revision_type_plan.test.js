const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  RETYPE,
  DOCUMENT_TYPES,
  planEntryRevisionRetype,
} = require("./entry_revision_type_plan");

const revision = (id, entryType, kind = "revision") => ({
  _id: id,
  entryRef: `e-${id}`,
  userId: "u1",
  kind,
  entryType,
  createdDate: 1700000000000,
  snapshot: { status: "Completed" },
});

const idsFor = (plan, to) =>
  plan.updates.find((update) => update.to === to)?.ids ?? [];

test("the mapping is the one work_types.js already holds", () => {
  // Not a second copy of the table: if a type were added with a different
  // pair of spellings, this is read from the same row the API writes from.
  assert.deepEqual(RETYPE, {
    films: "Film",
    tv: "TVShow",
    games: "Game",
    books: "Book",
  });
  assert.deepEqual([...DOCUMENT_TYPES], ["Film", "TVShow", "Game", "Book"]);
});

test("a document carrying the url spelling is rewritten to the document one", () => {
  const plan = planEntryRevisionRetype([
    revision("r1", "films"),
    revision("r2", "tv"),
    revision("r3", "games"),
    revision("r4", "books"),
  ]);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(idsFor(plan, "Film"), ["r1"]);
  assert.deepEqual(idsFor(plan, "TVShow"), ["r2"]);
  assert.deepEqual(idsFor(plan, "Game"), ["r3"]);
  assert.deepEqual(idsFor(plan, "Book"), ["r4"]);
  assert.equal(plan.totals.toRewrite, 4);
});

test("documents of one type are rewritten in a single group", () => {
  // What the script turns into one `updateMany` per value, rather than a
  // write per document.
  const plan = planEntryRevisionRetype([
    revision("r1", "films"),
    revision("r2", "films", "draft"),
    revision("r3", "films"),
  ]);

  assert.equal(plan.updates.length, 1);
  assert.deepEqual(idsFor(plan, "Film"), ["r1", "r2", "r3"]);
  // Drafts are counted separately only so the dry run can say how much of
  // what it is about to touch is somebody's unsaved edit.
  assert.equal(plan.updates[0].drafts, 1);
});

test("a document already carrying the document spelling is left alone", () => {
  // The run has to be repeatable: the API writes 'Film' now, so every
  // document written after the deploy is already correct.
  const plan = planEntryRevisionRetype([
    revision("r1", "Film"),
    revision("r2", "TVShow"),
    revision("r3", "films"),
  ]);

  assert.equal(plan.totals.alreadyCorrect, 2);
  assert.equal(plan.totals.toRewrite, 1);
  assert.deepEqual(idsFor(plan, "Film"), ["r3"]);
});

test("running the plan over its own output is a no-op", () => {
  const before = [revision("r1", "films"), revision("r2", "tv")];
  const applied = before.map((doc) => ({
    ...doc,
    entryType: RETYPE[doc.entryType],
  }));

  const plan = planEntryRevisionRetype(applied);

  assert.deepEqual(plan.updates, []);
  assert.equal(plan.totals.alreadyCorrect, 2);
  assert.equal(plan.totals.unrecognised, 0);
});

test("a document carrying neither spelling is reported, not guessed at", () => {
  const plan = planEntryRevisionRetype([
    revision("r1", undefined),
    revision("r2", "albums"),
    revision("r3", 7),
    revision("r4", "Films"),
    revision("r5", "films"),
  ]);

  assert.equal(plan.totals.unrecognised, 4);
  assert.deepEqual(
    plan.unrecognised.map((doc) => doc._id),
    ["r1", "r2", "r3", "r4"]
  );
  // The one that could be mapped still is: an odd document nearby is not a
  // reason to leave the rest of the collection half-migrated.
  assert.deepEqual(idsFor(plan, "Film"), ["r5"]);
});

test("an unrecognised document says what it was, so it can be looked up", () => {
  const plan = planEntryRevisionRetype([revision("r1", "albums", "draft")]);

  assert.deepEqual(plan.unrecognised, [
    { _id: "r1", entryType: "albums", kind: "draft" },
  ]);
  // Never the snapshot: the report is read in a terminal and a snapshot holds
  // somebody's note.
  assert.equal("snapshot" in plan.unrecognised[0], false);
});

test("an empty collection plans nothing rather than refusing", () => {
  // Unlike the orphan-review and dead-field plans, an empty read is not
  // dangerous here: nothing is deleted, and a plan with no ids writes
  // nothing at all.
  const plan = planEntryRevisionRetype([]);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.totals, {
    revisions: 0,
    alreadyCorrect: 0,
    toRewrite: 0,
    unrecognised: 0,
  });
});

test("anything that is not a list of documents is refused", () => {
  for (const input of [undefined, null, "films", { _id: "r1" }]) {
    assert.equal(typeof planEntryRevisionRetype(input).blocked, "string");
  }
});

test("the updates are in the order the site presents the types", () => {
  const plan = planEntryRevisionRetype([
    revision("r1", "books"),
    revision("r2", "games"),
    revision("r3", "films"),
  ]);

  assert.deepEqual(
    plan.updates.map((update) => update.to),
    ["Film", "Game", "Book"]
  );
});
