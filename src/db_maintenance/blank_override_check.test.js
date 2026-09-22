const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyBlankOverrides,
  isBlankList,
  hasRealValue,
} = require("./blank_override_check");

const work = (id, fields = {}) => ({ _id: id, title: `work ${id}`, ...fields });
const entry = (id, workRef, overrides) => ({
  _id: id,
  userId: "u1",
  workRef,
  overrides,
});

const fieldsOf = (found) => found.fields.map((f) => f.field);

test("an empty list over a work that has the value is a masked row", () => {
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { directors: [""] })],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(report.masking.length, 1);
  assert.equal(report.harmless.length, 0);
  assert.deepEqual([...fieldsOf(report.masking[0])], ["directors"]);
  assert.deepEqual([...report.masking[0].fields[0].workValue], [
    "Amy Sherman-Palladino",
  ]);
  assert.equal(report.totals.maskingKeys, 1);
});

test("an empty list over a work that has nothing is harmless, not masking", () => {
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { genres: [""] })],
    [work("w1", {})]
  );

  assert.equal(report.masking.length, 0);
  assert.equal(report.harmless.length, 1);
  assert.equal(report.harmless[0].fields[0].masks, false);
  assert.equal(report.totals.maskingKeys, 0);
  assert.equal(report.totals.blankKeys, 1);
});

test("the work's own unusable values are nothing to hide", () => {
  // The three shapes #291 counted on the works side. An override over any of
  // them renders exactly what the work renders, which is nothing.
  const report = classifyBlankOverrides(
    [
      entry("e1", "w1", { publishers: [""] }),
      entry("e2", "w2", { directors: [""] }),
      entry("e3", "w3", { actors: [""] }),
    ],
    [
      work("w1", { publishers: {} }),
      work("w2", { directors: [""] }),
      work("w3", { actors: [] }),
    ]
  );

  assert.equal(report.masking.length, 0);
  assert.equal(report.harmless.length, 3);
});

test("a list with anything readable in it is a real override and is not reported", () => {
  const report = classifyBlankOverrides(
    [
      entry("e1", "w1", { directors: ["", "Christopher Nolan"] }),
      entry("e2", "w1", { actors: ["Tilda Swinton"] }),
    ],
    [work("w1", { directors: ["Someone Else"], actors: ["Someone Else"] })]
  );

  assert.equal(report.masking.length, 0);
  assert.equal(report.harmless.length, 0);
  assert.equal(report.totals.blankKeys, 0);
  assert.equal(report.totals.keys, 2);
});

test("a null is the form's deliberate clear and is never reported", () => {
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { directors: null, actors: undefined })],
    [work("w1", { directors: ["Amy Sherman-Palladino"], actors: ["Lauren"] })]
  );

  assert.equal(report.masking.length, 0);
  assert.equal(report.harmless.length, 0);
  assert.equal(report.totals.blankKeys, 0);
});

test("the two shapes the file header rules out stay ruled out", () => {
  // `[]` and `""` mask a work's value by the same route and are deliberately
  // not counted here — see the header. Pinned so that including one later is
  // a decision somebody makes rather than a test that starts failing.
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { directors: [], actors: "" })],
    [work("w1", { directors: ["Amy Sherman-Palladino"], actors: ["Lauren"] })]
  );

  assert.equal(report.totals.blankKeys, 0);
  assert.equal(isBlankList([]), false);
  assert.equal(isBlankList(""), false);
});

test("whitespace renders as blank and counts as blank", () => {
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { directors: [" ", "\t"] })],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(report.masking.length, 1);
});

test("a member that is not a string is not this module's to call empty", () => {
  assert.equal(isBlankList([0]), false);
  assert.equal(isBlankList([{}]), false);
  assert.equal(isBlankList([null, ""]), true);
});

test("an entry with no readable work is undecided, not harmless", () => {
  const report = classifyBlankOverrides(
    [
      entry("e1", undefined, { directors: [""] }),
      entry("e2", "gone", { genres: [""] }),
    ],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(report.masking.length, 0);
  assert.equal(report.harmless.length, 0);
  assert.equal(report.undecided.length, 2);
  assert.deepEqual(
    [...report.undecided.map((u) => u.reason)],
    ["entry points at no work", "workRef points at a work that is gone"]
  );
  assert.equal(report.byField.directors.undecided, 1);
  assert.equal(report.byField.genres.undecided, 1);
});

test("a row is counted once, as damage, when any of its fields masks", () => {
  // ポケモン：ワイルドカード in #395: the genres and the director go together.
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { genres: [""], directors: [""] })],
    [work("w1", { directors: ["Kunihiko Yuyama"] })]
  );

  assert.equal(report.masking.length, 1);
  assert.equal(report.harmless.length, 0);
  assert.equal(report.totals.entriesAffected, 1);
  // The row is one row; the keys are two, and the breakdown is about keys.
  assert.equal(report.totals.blankKeys, 2);
  assert.equal(report.byField.directors.masking, 1);
  assert.equal(report.byField.genres.harmless, 1);
});

test("the buckets partition the affected entries", () => {
  const report = classifyBlankOverrides(
    [
      entry("e1", "w1", { directors: [""] }),
      entry("e2", "w1", { genres: [""] }),
      entry("e3", undefined, { genres: [""] }),
      entry("e4", "w1", { directors: ["Céline Sciamma"] }),
      entry("e5", "w1", {}),
      entry("e6", "w1", undefined),
    ],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(report.masking.length, 1);
  assert.equal(report.harmless.length, 1);
  assert.equal(report.undecided.length, 1);
  assert.equal(
    report.masking.length + report.harmless.length + report.undecided.length,
    report.totals.entriesAffected
  );
  assert.equal(report.totals.entries, 6);
  // e6 has no overrides object at all; e5's is empty.
  assert.equal(report.totals.withOverrides, 4);
});

test("the field breakdown counts every key, in every bucket", () => {
  const report = classifyBlankOverrides(
    [
      entry("e1", "w1", { actors: [""] }),
      entry("e2", "w1", { actors: [""] }),
      entry("e3", "w2", { actors: [""] }),
      entry("e4", undefined, { actors: [""] }),
    ],
    [work("w1", { actors: ["Lauren Graham"] }), work("w2", {})]
  );

  assert.deepEqual(
    { ...report.byField.actors },
    { masking: 2, harmless: 1, undecided: 1 }
  );
});

test("an id compares the way the driver hands it over, not as an object", () => {
  const id = { toString: () => "w1" };
  const report = classifyBlankOverrides(
    [entry("e1", { toString: () => "w1" }, { directors: [""] })],
    [work(id, { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(report.masking.length, 1);
});

test("a works collection that came back empty blocks rather than answering", () => {
  const report = classifyBlankOverrides(
    [entry("e1", "w1", { directors: [""] })],
    []
  );

  assert.match(report.blocked, /works collection came back empty/);
  assert.equal(report.masking.length, 0);
  assert.equal(report.undecided.length, 0);
});

test("no entries pointing anywhere is not a failed read", () => {
  const report = classifyBlankOverrides(
    [entry("e1", undefined, { directors: [""] })],
    []
  );

  assert.equal(report.blocked, undefined);
  assert.equal(report.undecided.length, 1);
});

test("anything that is not two arrays blocks", () => {
  assert.match(classifyBlankOverrides(undefined, []).blocked, /must both be/);
  assert.match(classifyBlankOverrides([], undefined).blocked, /must both be/);
});

test("a zero on the work is empty, as it is everywhere else in this folder", () => {
  assert.equal(hasRealValue(0), false);
  assert.equal(hasRealValue(120), true);
  assert.equal(hasRealValue(NaN), false);
  assert.equal(hasRealValue({}), false);
  assert.equal(hasRealValue({ name: "x" }), true);
  assert.equal(hasRealValue(""), false);
  assert.equal(hasRealValue("  "), false);
  assert.equal(hasRealValue("Amy Sherman-Palladino"), true);
  assert.equal(hasRealValue(undefined), false);
});
