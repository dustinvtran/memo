const { test } = require("node:test");
const assert = require("node:assert/strict");

const { planNullOverrideReport, updatedYear } = require("./null_override_plan");

const work = (id, metadata = {}) => ({ _id: id, ...metadata });
const entry = (id, overrides, fields = {}) => ({
  _id: id,
  userId: "u1",
  workRef: "w1",
  updatedDate: Date.UTC(2022, 5, 1),
  ...(overrides === undefined ? {} : { overrides }),
  ...fields,
});

const ids = (reported) => reported.map((r) => r._id);

test("an overrides object of nothing but nulls is reported and proposed", () => {
  const overrides = { releaseYear: null, duration: null, genres: null };
  const plan = planNullOverrideReport(
    [entry("e1", overrides)],
    [work("w1", { releaseYear: 1979, duration: 162 })]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(ids(plan.allNull), ["e1"]);
  assert.deepEqual(plan.allNull[0].fields, ["releaseYear", "duration", "genres"]);
  // Only the fields the work can fill are ones a removal would reveal.
  assert.deepEqual(plan.allNull[0].hides, ["releaseYear", "duration"]);
  assert.deepEqual(plan.removals, [{ _id: "e1", overrides }]);
  assert.equal(plan.totals.allNull, 1);
  assert.equal(plan.totals.allNullHidingYear, 1);
});

test("the report carries the entry id, userId, updatedDate and keys", () => {
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: null }, { userId: "u9", updatedDate: 123 })],
    [work("w1", { releaseYear: 2001 })]
  );

  const [reported] = plan.allNull;
  assert.equal(reported._id, "e1");
  assert.equal(reported.userId, "u9");
  assert.equal(reported.updatedDate, 123);
  assert.deepEqual(reported.fields, ["releaseYear"]);
  assert.equal(reported.workYear, 2001);
});

test("a null year beside a real override is reported and never proposed", () => {
  // The mixed case: a real value next to the null is evidence someone was
  // choosing field by field, so the null may well be deliberate.
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: null, englishTranslatedTitle: "Сталкер" })],
    [work("w1", { releaseYear: 1979, englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.allNull, []);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(ids(plan.releaseYearNull), ["e1"]);
  assert.equal(plan.releaseYearNull[0].allNull, false);
  assert.deepEqual(plan.releaseYearNull[0].nullFields, ["releaseYear"]);
  assert.equal(plan.totals.releaseYearNullMixed, 1);
});

test("an all-null entry hiding a year is in both lists and is not counted as mixed", () => {
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: null, duration: null })],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.deepEqual(ids(plan.allNull), ["e1"]);
  assert.deepEqual(ids(plan.releaseYearNull), ["e1"]);
  assert.equal(plan.totals.releaseYearNull, 1);
  assert.equal(plan.totals.releaseYearNullMixed, 0);
  assert.equal(plan.removals.length, 1);
});

test("a null year over a work with no year hides nothing and is not in the year list", () => {
  // 0 is not a year either: `isEmptyValue` says so for every field.
  const plan = planNullOverrideReport(
    [
      entry("e1", { releaseYear: null, score: 3 }),
      entry("e2", { releaseYear: null, score: 3 }, { workRef: "w2" }),
    ],
    [work("w1", {}), work("w2", { releaseYear: 0 })]
  );

  assert.deepEqual(plan.releaseYearNull, []);
  assert.deepEqual(plan.allNull, []);
});

test("an all-null object over a work with no year is still proposed", () => {
  // It hides nothing today, which makes removing it the safer half, not a
  // reason to leave it.
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: null, genres: null })],
    [work("w1", {})]
  );

  assert.deepEqual(ids(plan.allNull), ["e1"]);
  assert.deepEqual(plan.allNull[0].hides, []);
  assert.deepEqual(plan.releaseYearNull, []);
  assert.equal(plan.totals.allNullHidingYear, 0);
});

test("a missing releaseYear key is not a null one", () => {
  const plan = planNullOverrideReport(
    [entry("e1", { englishTranslatedTitle: "Сталкер" })],
    [work("w1", { releaseYear: 1979, englishTranslatedTitle: "Stalker" })]
  );

  assert.deepEqual(plan.releaseYearNull, []);
  assert.deepEqual(plan.allNull, []);
});

test("undefined counts as null, as a snapshot read off disk can carry it", () => {
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: undefined, duration: null })],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.deepEqual(ids(plan.allNull), ["e1"]);
  assert.deepEqual(ids(plan.releaseYearNull), ["e1"]);
});

test("an entry with no work, or a dangling one, is counted and never reported", () => {
  // For those the overrides are the metadata, not a layer over it.
  const plan = planNullOverrideReport(
    [
      entry("e1", { releaseYear: null }, { workRef: undefined }),
      entry("e2", { releaseYear: null }, { workRef: "gone" }),
      entry("e3", { releaseYear: null }),
    ],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.deepEqual(ids(plan.allNull), ["e3"]);
  assert.deepEqual(ids(plan.removals), ["e3"]);
  assert.equal(plan.totals.withOverrides, 3);
  assert.equal(plan.totals.linkedWithOverrides, 1);
  assert.equal(plan.totals.unlinkedWithOverrides, 2);
});

test("an empty overrides object, or none at all, is not all-null", () => {
  const plan = planNullOverrideReport(
    [entry("e1", {}), entry("e2", undefined), entry("e3", null)],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.deepEqual(plan.allNull, []);
  assert.deepEqual(plan.releaseYearNull, []);
  assert.equal(plan.totals.withOverrides, 0);
});

test("workRefs compare by string, so an ObjectId-shaped id finds its work", () => {
  const oid = { toString: () => "abc" };
  const plan = planNullOverrideReport(
    [entry("e1", { releaseYear: null }, { workRef: oid })],
    [work({ toString: () => "abc" }, { releaseYear: 1979 })]
  );

  assert.deepEqual(ids(plan.allNull), ["e1"]);
});

test("counts are split by user and by the year of updatedDate", () => {
  const plan = planNullOverrideReport(
    [
      entry("e1", { releaseYear: null }),
      entry("e2", { releaseYear: null }, { userId: "u2" }),
      entry(
        "e3",
        { releaseYear: null, score: 3 },
        { updatedDate: Date.UTC(2023, 0, 1) }
      ),
    ],
    [work("w1", { releaseYear: 1979 })]
  );

  assert.deepEqual(plan.byUser, {
    u1: { allNull: 1, releaseYearNull: 2 },
    u2: { allNull: 1, releaseYearNull: 1 },
  });
  assert.deepEqual(plan.byUpdatedYear, {
    2022: { allNull: 2, releaseYearNull: 2 },
    2023: { allNull: 0, releaseYearNull: 1 },
  });
});

test("entries pointing at works beside an empty works collection are refused", () => {
  const plan = planNullOverrideReport([entry("e1", { releaseYear: null })], []);

  assert.match(plan.blocked, /came back empty/);
  assert.deepEqual(plan.removals, []);
});

test("non-array input is refused rather than read as empty", () => {
  assert.match(planNullOverrideReport(undefined, []).blocked, /arrays/);
});

test("updatedYear reads a number, a Date and a string, and nothing else", () => {
  assert.equal(updatedYear(Date.UTC(2022, 11, 31, 23)), "2022");
  assert.equal(updatedYear(new Date(Date.UTC(2023, 0, 1))), "2023");
  assert.equal(updatedYear("2021-06-01T00:00:00Z"), "2021");
  assert.equal(updatedYear(undefined), "unknown");
  assert.equal(updatedYear("not a date"), "unknown");
});
