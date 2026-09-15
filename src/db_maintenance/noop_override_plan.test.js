const { test } = require("node:test");
const assert = require("node:assert/strict");

const { planNoopOverrideRemoval, isSameStoredValue } = require("./noop_override_plan");

const work = (id, metadata = {}) => ({ _id: id, ...metadata });
const entry = (id, overrides, fields = {}) => ({
  _id: id,
  userId: "u1",
  workRef: "w1",
  ...(overrides === undefined ? {} : { overrides }),
  ...fields,
});

/** The fields this plan would unset from an entry, by its id. */
const removedFrom = (plan, id) =>
  plan.removals.find((removal) => removal._id === id)?.fields ?? [];

const keptFields = (plan) => plan.kept.real.map((kept) => kept.field);

test("an override holding the work's own value is removed", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { englishTranslatedTitle: "Overwatch 2", releaseYear: 2022 })],
    [work("w1", { englishTranslatedTitle: "Overwatch 2", releaseYear: 2022 })]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(removedFrom(plan, "e1"), [
    "englishTranslatedTitle",
    "releaseYear",
  ]);
  assert.equal(plan.totals.removed, 2);
  assert.equal(plan.totals.real, 0);
});

test("an override holding something else is a user decision and stays", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { englishTranslatedTitle: "Сталкер" })],
    [work("w1", { englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.removals, []);
  assert.deepEqual(keptFields(plan), ["englishTranslatedTitle"]);
  assert.deepEqual(plan.kept.real[0], {
    _id: "e1",
    field: "englishTranslatedTitle",
    stored: "Сталкер",
    workValue: "Stalker",
  });
});

test("a null override is a field the user cleared, and is never removed", () => {
  // Removing it would un-clear the field: `withOverrides` drops a null so the
  // work's value would come back, which is the visible change this must not
  // make.
  const plan = planNoopOverrideRemoval(
    [entry("e1", { releaseYear: null, duration: null })],
    [work("w1", { releaseYear: 1979, duration: 162 })]
  );

  assert.deepEqual(plan.removals, []);
  assert.equal(plan.totals.cleared, 2);
  assert.equal(plan.totals.removed, 0);
});

test("a null over a work that has nothing there either is still left alone", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { releaseYear: null })],
    [work("w1", {})]
  );

  assert.deepEqual(plan.removals, []);
  assert.equal(plan.totals.cleared, 1);
});

test("the comparison is against the work, not the merged commonMetadata", () => {
  // The trap this plan exists to avoid. Both the row builder in list.js and
  // `getUserEntries` hand out a `commonMetadata` with the overrides already
  // folded in, and the stale copy stored on the entry is #176's snapshot of
  // the same shape. Comparing against either finds every override identical
  // to itself.
  const plan = planNoopOverrideRemoval(
    [
      entry(
        "e1",
        { englishTranslatedTitle: "Сталкер" },
        { commonMetadata: { englishTranslatedTitle: "Сталкер" } }
      ),
    ],
    [work("w1", { englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.removals, []);
  assert.deepEqual(keptFields(plan), ["englishTranslatedTitle"]);
});

test("a list override matching the work's list is removed, and a reordered one is not", () => {
  // Order is what a list column prints, so two orderings are two renders.
  const plan = planNoopOverrideRemoval(
    [
      entry("same", { genres: ["Shooter", "Strategy"] }),
      entry("reordered", { genres: ["Strategy", "Shooter"] }),
      entry("longer", { genres: ["Shooter", "Strategy", "Indie"] }),
    ],
    [work("w1", { genres: ["Shooter", "Strategy"] })]
  );

  assert.deepEqual(removedFrom(plan, "same"), ["genres"]);
  assert.deepEqual(removedFrom(plan, "reordered"), []);
  assert.deepEqual(removedFrom(plan, "longer"), []);
  assert.equal(plan.totals.real, 2);
});

test("an override filling a gap the work has is a real one", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { directors: ["Andrei Tarkovsky"] })],
    [work("w1", {})]
  );

  assert.deepEqual(plan.removals, []);
  assert.deepEqual(keptFields(plan), ["directors"]);
});

test("the overrides object goes only when nothing is left in it", () => {
  const plan = planNoopOverrideRemoval(
    [
      entry("all-noop", { englishTranslatedTitle: "Stalker", releaseYear: 1979 }),
      entry("a-null-left", { englishTranslatedTitle: "Stalker", duration: null }),
      entry("a-real-left", { englishTranslatedTitle: "Stalker", releaseYear: 1980 }),
    ],
    [work("w1", { englishTranslatedTitle: "Stalker", releaseYear: 1979 })]
  );

  const dropping = (id) =>
    plan.removals.find((removal) => removal._id === id)?.dropsObject;

  assert.equal(dropping("all-noop"), true);
  assert.equal(dropping("a-null-left"), false);
  assert.equal(dropping("a-real-left"), false);
  assert.equal(plan.totals.objectsDropped, 1);
  assert.equal(plan.totals.entriesTouched, 3);
});

test("an entry that points at no work is left entirely alone", () => {
  // The 23 hand-typed entries: `overrides` is not a layer over the metadata,
  // it is the only metadata there is.
  const plan = planNoopOverrideRemoval(
    [entry("e1", { englishTranslatedTitle: "Stalker" }, { workRef: undefined })],
    [work("w1", { englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.removals, []);
  assert.equal(plan.kept.skipped.length, 1);
  assert.equal(plan.kept.skipped[0].reason, "entry points at no work");
  assert.equal(plan.totals.skippedKeys, 1);
});

test("an entry whose work is gone is left alone rather than emptied", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { englishTranslatedTitle: "Stalker" }, { workRef: "gone" })],
    [work("w1", { englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.removals, []);
  assert.equal(plan.kept.skipped[0].reason, "workRef points at a work that is gone");
});

test("an ObjectId-shaped ref joins by its string spelling", () => {
  const id = { toString: () => "507f1f77bcf86cd799439011" };
  const otherId = { toString: () => "507f1f77bcf86cd799439011" };
  const plan = planNoopOverrideRemoval(
    [entry("e1", { releaseYear: 1979 }, { workRef: id })],
    [work(otherId, { releaseYear: 1979 })]
  );

  assert.deepEqual(removedFrom(plan, "e1"), ["releaseYear"]);
});

test("entries pointing at works beside an empty works collection are refused", () => {
  const plan = planNoopOverrideRemoval([entry("e1", { releaseYear: 1979 })], []);

  assert.match(plan.blocked, /works collection came back empty/);
  assert.deepEqual(plan.removals, []);
});

test("an entry with no overrides at all is not counted as one carrying them", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", undefined), entry("e2", {}), entry("e3", { releaseYear: 1979 })],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.equal(plan.totals.entries, 3);
  assert.equal(plan.totals.withOverrides, 1);
  assert.equal(plan.totals.keys, 1);
});

test("the counts are grouped by field, removals and survivors alike", () => {
  const plan = planNoopOverrideRemoval(
    [
      entry("e1", { releaseYear: 1979, duration: 100, genres: null }),
      entry("e2", { releaseYear: 1979, duration: 162 }),
    ],
    [work("w1", { releaseYear: 1979, duration: 162, genres: ["Drama"] })]
  );

  assert.deepEqual(plan.byField, {
    releaseYear: { removed: 2, real: 0, cleared: 0 },
    duration: { removed: 1, real: 1, cleared: 0 },
    genres: { removed: 0, real: 0, cleared: 1 },
  });
});

test("neither argument being an array is refused rather than guessed at", () => {
  assert.match(planNoopOverrideRemoval(undefined, []).blocked, /must both be arrays/);
  assert.match(planNoopOverrideRemoval([], undefined).blocked, /must both be arrays/);
});

test("the size reported is the keys that would go, not the whole object", () => {
  const plan = planNoopOverrideRemoval(
    [entry("e1", { releaseYear: 1979, englishTranslatedTitle: "Сталкер" })],
    [work("w1", { releaseYear: 1979, englishTranslatedTitle: "Stalker" })]
  );

  assert.equal(plan.totals.jsonChars, '"releaseYear"'.length + "1979".length + 2);
});

test("sameness is strict where the form's own comparison is forgiving", () => {
  // `isSameValue` in entry_form_io.js drops blanks out of a list before
  // comparing, because it is answering "did the user type something new".
  // This asks "would removing this change the render", and `[""]` over a work
  // with nothing renders differently from nothing at all.
  assert.equal(isSameStoredValue([], [""]), false);
  assert.equal(isSameStoredValue(undefined, [""]), false);
  assert.equal(isSameStoredValue(["Drama"], ["Drama"]), true);

  // Types are not coerced: a year stored as a string is a different value.
  assert.equal(isSameStoredValue(1979, "1979"), false);
  assert.equal(isSameStoredValue(0, false), false);
  assert.equal(isSameStoredValue(null, undefined), false);
});

test("sameness recurses into plain objects and refuses anything else", () => {
  assert.equal(
    isSameStoredValue(
      [{ name: "IMDb", url: "https://imdb.com/title/tt0079944" }],
      [{ name: "IMDb", url: "https://imdb.com/title/tt0079944" }]
    ),
    true
  );
  assert.equal(
    isSameStoredValue({ name: "IMDb", url: "a" }, { name: "IMDb", url: "b" }),
    false
  );
  // An extra key on one side is a difference, in either direction.
  assert.equal(isSameStoredValue({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(isSameStoredValue({ a: 1, b: 2 }, { a: 1 }), false);
  // Not a plain object: two equal Dates are kept rather than called the same.
  assert.equal(isSameStoredValue(new Date(0), new Date(0)), false);
});
