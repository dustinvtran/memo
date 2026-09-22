const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  planBlankOverrideRemoval,
  unsetPaths,
} = require("./blank_override_plan");
const { classifyBlankOverrides } = require("./blank_override_check");

const work = (id, fields = {}) => ({ _id: id, title: `work ${id}`, ...fields });
const entry = (id, workRef, overrides) => ({
  _id: id,
  userId: "u1",
  workRef,
  overrides,
});

const fieldsOf = (removal) => removal.fields.map((f) => f.field);
const keptFields = (plan) => plan.kept.real.map((k) => k.field);

test("a blank list over a work that has the value is removed", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: [""] })],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })]
  );

  assert.equal(plan.blocked, undefined);
  assert.equal(plan.removals.length, 1);
  assert.deepEqual([...fieldsOf(plan.removals[0])], ["directors"]);
  assert.equal(plan.removals[0].fields[0].masks, true);
  assert.deepEqual([...plan.removals[0].fields[0].workValue], [
    "Amy Sherman-Palladino",
  ]);
  assert.equal(plan.totals.removed, 1);
  assert.equal(plan.totals.maskingKeys, 1);
  assert.equal(plan.totals.maskedRows, 1);
});

test("a blank list over a work that has nothing is removed too", () => {
  // The 139 books carrying `genres: [""]` hide nothing only because Google
  // Books has told us no genres yet. The key is still wrong, and the moment a
  // refresh fills the field it starts masking it.
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { genres: [""] })],
    [work("w1", {})]
  );

  assert.equal(plan.removals.length, 1);
  assert.equal(plan.removals[0].fields[0].masks, false);
  assert.equal(plan.totals.harmlessKeys, 1);
  assert.equal(plan.totals.removed, 1);
  assert.equal(plan.totals.maskedRows, 0);
});

test("whitespace members are blank, because whitespace renders as blank", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { actors: [" ", "", "\t"] })],
    [work("w1", { actors: ["Tilda Swinton"] })]
  );

  assert.equal(plan.totals.removed, 1);
});

test("a null is never touched", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: null, actors: undefined })],
    [work("w1", { directors: ["Someone"], actors: ["Someone"] })]
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.cleared, 2);
  assert.equal(plan.totals.removed, 0);
  assert.equal(plan.byField.directors.cleared, 1);
});

test("a list with any non-blank member is never touched", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: ["", "Christopher Nolan"] })],
    [work("w1", { directors: ["Someone Else"] })]
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.real, 1);
  assert.equal(plan.kept.real[0].reason, "a real override");
});

test("an empty list and a blank scalar are kept, and say why", () => {
  // Both do the same damage by the same route and neither is measured yet;
  // clearing what the audit does not report would leave the script
  // uncheckable against the audit. ./blank_override_check.js's file header.
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { genres: [], englishTranslatedTitle: "  " })],
    [work("w1", { genres: ["Drama"], englishTranslatedTitle: "Dune" })]
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.real, 2);
  assert.deepEqual([...keptFields(plan)].sort(), [
    "englishTranslatedTitle",
    "genres",
  ]);
  for (const kept of plan.kept.real) {
    assert.match(kept.reason, /#395 did not measure/);
  }
});

test("an entry with no work is skipped entirely, keys and all", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", undefined, { directors: [""], genres: [""] })],
    [work("w1", { directors: ["Someone"] })]
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.skippedEntries, 1);
  assert.equal(plan.totals.skippedKeys, 2);
  assert.equal(plan.kept.skipped[0].reason, "entry points at no work");
  assert.equal(plan.byField.directors.undecided, 1);
});

test("a dangling workRef is skipped the same way", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "gone", { directors: [""] })],
    [work("w1", { directors: ["Someone"] })]
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.skippedEntries, 1);
  assert.equal(
    plan.kept.skipped[0].reason,
    "workRef points at a work that is gone"
  );
});

test("the overrides object is dropped only when nothing else is in it", () => {
  const plan = planBlankOverrideRemoval(
    [
      entry("e1", "w1", { directors: [""] }),
      entry("e2", "w1", { directors: [""], genres: ["Drama"] }),
      entry("e3", "w1", { directors: [""], actors: null }),
    ],
    [work("w1", { directors: ["Someone"], genres: ["Comedy"] })]
  );

  const byId = new Map(plan.removals.map((r) => [r._id, r]));
  assert.equal(byId.get("e1").dropsObject, true);
  assert.equal(byId.get("e2").dropsObject, false);
  // A kept null still counts as something else in the object: an entry whose
  // every blank key goes still has its cleared fields to keep.
  assert.equal(byId.get("e3").dropsObject, false);
  assert.equal(plan.totals.objectsDropped, 1);
  assert.equal(plan.totals.entriesTouched, 3);
});

test("the unset names one key at a time, and only under overrides", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: [""], actors: [""], score: 9 })],
    [work("w1", { directors: ["Someone"], actors: ["Someone"] })]
  );

  assert.deepEqual(unsetPaths(plan.removals[0]), {
    "overrides.directors": "",
    "overrides.actors": "",
  });
});

test("dropping the object is the one unset that is not a single key", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: [""] })],
    [work("w1", { directors: ["Someone"] })]
  );

  assert.deepEqual(unsetPaths(plan.removals[0]), { overrides: "" });
});

test("nothing a removal writes is a $set, and updatedDate is unreachable", () => {
  const plan = planBlankOverrideRemoval(
    [
      entry("e1", "w1", { directors: [""] }),
      entry("e2", "w1", { genres: [""], actors: ["Real Name"] }),
    ],
    [work("w1", { directors: ["Someone"], genres: ["Drama"] })]
  );

  for (const removal of plan.removals) {
    for (const path of Object.keys(unsetPaths(removal))) {
      assert.ok(
        path === "overrides" || path.startsWith("overrides."),
        `${path} is outside overrides`
      );
    }
  }
});

test("a masking-only run removes the masking keys and holds the rest back", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: [""], genres: [""] })],
    [work("w1", { directors: ["Amy Sherman-Palladino"] })],
    { maskingOnly: true }
  );

  assert.equal(plan.removals.length, 1);
  assert.deepEqual([...fieldsOf(plan.removals[0])], ["directors"]);
  assert.equal(plan.removals[0].dropsObject, false);
  assert.equal(plan.totals.removed, 1);
  assert.equal(plan.totals.heldBack, 1);
  assert.equal(plan.kept.heldBack[0].field, "genres");
  assert.equal(plan.byField.genres.harmless, 1);
  assert.equal(plan.byField.genres.removed, 0);
});

test("a masking-only run can leave an entry untouched altogether", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { genres: [""] })],
    [work("w1", {})],
    { maskingOnly: true }
  );

  assert.equal(plan.removals.length, 0);
  assert.equal(plan.totals.entriesTouched, 0);
  assert.equal(plan.totals.heldBack, 1);
});

test("a key whose own name is not a path is refused, not mis-addressed", () => {
  // `overrides.a.b` names something nested and `overrides.$x` reads as an
  // operator, so there is no $unset that reaches either one key at a time.
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { "a.b": [""], $set: [""], directors: [""] })],
    [work("w1", { directors: ["Someone"] })]
  );

  assert.equal(plan.totals.unaddressable, 2);
  assert.equal(plan.totals.removed, 1);
  assert.deepEqual([...fieldsOf(plan.removals[0])], ["directors"]);
  assert.deepEqual(unsetPaths(plan.removals[0]), {
    "overrides.directors": "",
  });
  // And the object survives, because two keys are staying in it.
  assert.equal(plan.removals[0].dropsObject, false);
  for (const kept of plan.kept.unaddressable) {
    assert.match(kept.reason, /not addressable/);
  }
});

test("a works collection that came back empty is refused, not answered", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", "w1", { directors: [""] })],
    []
  );

  assert.match(plan.blocked, /came back empty/);
  assert.equal(plan.removals.length, 0);
});

test("no entry points at a work, so an empty works collection is fine", () => {
  const plan = planBlankOverrideRemoval(
    [entry("e1", undefined, { directors: [""] })],
    []
  );

  assert.equal(plan.blocked, undefined);
  assert.equal(plan.totals.skippedEntries, 1);
});

test("a non-array argument is refused rather than crashed on", () => {
  assert.match(planBlankOverrideRemoval(undefined, []).blocked, /must both be/);
  assert.match(planBlankOverrideRemoval([], null).blocked, /must both be/);
});

test("an entry with no overrides object is counted and left alone", () => {
  // An `overrides` of `{}` is "no overrides" here, as it is in
  // ./noop_override_plan.js: there are no keys, so there is nothing to
  // decide and nothing to count.
  const plan = planBlankOverrideRemoval(
    [{ _id: "e1", workRef: "w1" }, entry("e2", "w1", {})],
    [work("w1", { directors: ["Someone"] })]
  );

  assert.equal(plan.totals.entries, 2);
  assert.equal(plan.totals.withOverrides, 0);
  assert.equal(plan.totals.keys, 0);
  assert.equal(plan.removals.length, 0);
});

test("the works are joined by id, so the value compared is the right one", () => {
  // The trap ./noop_override_plan.js names: a `commonMetadata` on the entry
  // has the overrides folded into it already, and a stale one disagrees with
  // the works collection outright. Neither is what this decides against.
  const plan = planBlankOverrideRemoval(
    [
      {
        ...entry("e1", "w2", { directors: [""] }),
        commonMetadata: { directors: [""] },
      },
    ],
    [work("w1", { directors: ["Wrong Work"] }), work("w2", { directors: [] })]
  );

  assert.equal(plan.removals.length, 1);
  assert.equal(plan.removals[0].fields[0].masks, false);
});

test("a removal is exactly what the audit reports, key for key", () => {
  // The one thing that could drift silently: the audit counts what is wrong
  // and the script clears it, and a reader comparing the two numbers is
  // entitled to have them mean the same keys. Shared `isBlankList` is how,
  // and this is the assertion that it stayed shared.
  const entries = [
    entry("e1", "w1", { directors: [""] }),
    entry("e2", "w1", { genres: [" "], actors: ["Real Name"] }),
    entry("e3", "w1", { directors: null }),
    entry("e4", "w1", { platforms: [] }),
    entry("e5", "w1", { englishTranslatedTitle: "" }),
    entry("e6", undefined, { directors: [""] }),
    entry("e7", "gone", { genres: [""] }),
    entry("e8", "w2", { publishers: [""], studios: [""] }),
  ];
  const works = [
    work("w1", { directors: ["A Director"], genres: ["Drama"] }),
    work("w2", { publishers: ["A Publisher"] }),
  ];

  const report = classifyBlankOverrides(entries, works);
  const plan = planBlankOverrideRemoval(entries, works);

  const reported = [...report.masking, ...report.harmless].flatMap((found) =>
    found.fields.map((f) => `${found.id}.${f.field}`)
  );
  const planned = plan.removals.flatMap((removal) =>
    removal.fields.map((f) => `${removal._id}.${f.field}`)
  );

  assert.deepEqual([...planned].sort(), [...reported].sort());
  assert.equal(plan.totals.blankKeys, report.totals.blankKeys);
  assert.equal(plan.totals.maskingKeys, report.totals.maskingKeys);

  // And the keys on the entries nothing can decide are the difference between
  // what the audit counts and what a run removes, rather than an unexplained
  // gap between the two numbers.
  assert.equal(
    plan.totals.removed + plan.totals.skippedBlankKeys,
    report.totals.blankKeys
  );

  // And the entries the audit could not decide are the entries nothing is
  // written to, rather than merely happening not to appear in the removals.
  assert.deepEqual(
    [...plan.kept.skipped.map((s) => String(s._id))].sort(),
    [...report.undecided.map((u) => String(u.id))].sort()
  );

  // Per field too, in the audit's own three buckets: the run's by-field table
  // is printed so that a reader can lay it next to the audit's, which only
  // works if the three columns are the audit's numbers rather than a second
  // count of the same thing. The plan has rows the audit does not — a field
  // carrying only real overrides and nulls — and those must read as zeroes
  // rather than as a field the audit missed.
  for (const [field, counts] of Object.entries(plan.byField)) {
    assert.deepEqual(
      {
        masking: counts.masking,
        harmless: counts.harmless,
        undecided: counts.undecided,
      },
      report.byField[field] ?? { masking: 0, harmless: 0, undecided: 0 },
      `${field} disagrees with the audit`
    );
  }
});
