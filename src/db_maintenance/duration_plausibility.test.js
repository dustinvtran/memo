const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  implausibleDuration,
  descaleLadder,
  planDurationRepair,
  planDurationRepairs,
  durationOverridesByWorkRef,
} = require("./duration_plausibility");

const GAMES = { type: "games" };
const FILMS = { type: "films" };
const TV = { type: "tv" };
const BOOKS = { type: "books" };

const work = (overrides) => ({
  _id: "w1",
  englishTranslatedTitle: "Dying Light",
  ...overrides,
});

///////////////////////////////////////////////////////////////////////////////
// What counts as impossible

test("the number that started this is impossible", () => {
  assert.match(
    implausibleDuration(GAMES, work({ duration: 2939328000000000 })),
    /above the 200000/
  );
});

test("a real MMO playtime is not damage", () => {
  // RuneScape is genuinely stored at 127,680 minutes. A ceiling that flags it
  // is a ceiling that gets switched off.
  assert.equal(implausibleDuration(GAMES, work({ duration: 127680 })), undefined);
});

test("the ceilings are per type, because the units are", () => {
  // 1,200 is a fine page count and an impossible film runtime.
  assert.equal(implausibleDuration(BOOKS, work({ duration: 1200 })), undefined);
  assert.match(implausibleDuration(FILMS, work({ duration: 1200 })), /minutes/);
  // A show's duration is one episode's, so a season's worth is wrong.
  assert.match(
    implausibleDuration(TV, work({ duration: 425 })),
    /minutes per episode/
  );
});

test("a missing duration and a stored 0 are not implausible", () => {
  // Both render as `-`, and game_playtime_plan.js already owns the 0 case.
  assert.equal(implausibleDuration(GAMES, work({})), undefined);
  assert.equal(implausibleDuration(GAMES, work({ duration: 0 })), undefined);
  assert.equal(implausibleDuration(GAMES, work({ duration: null })), undefined);
});

test("wrong types and negatives are caught before the ceiling is", () => {
  assert.match(implausibleDuration(GAMES, work({ duration: "1050" })), /not a number/);
  assert.match(implausibleDuration(GAMES, work({ duration: NaN })), /not a number/);
  assert.match(implausibleDuration(GAMES, work({ duration: -5 })), /negative/);
});

test("a type with no band is not judged", () => {
  assert.equal(implausibleDuration({ type: "albums" }, work({ duration: 1e9 })), undefined);
});

///////////////////////////////////////////////////////////////////////////////
// Undoing the multiplications

test("the ladder undoes exact multiplications by 60, one at a time", () => {
  assert.deepEqual(descaleLadder(2939328000000000).at(-1), 1050);
  assert.equal(descaleLadder(2939328000000000).length, 7);
});

test("a number that is not a multiple of 60 has no ladder", () => {
  assert.deepEqual(descaleLadder(425), []);
});

test("the ladder never rounds", () => {
  // 3601 is 60*60 + 1: divisible by nothing, so there is no rung at all.
  assert.deepEqual(descaleLadder(3601), []);
});

///////////////////////////////////////////////////////////////////////////////
// Picking a value, and refusing to

test("a rung an override agrees with is the repair", () => {
  const plan = planDurationRepair(
    GAMES,
    work({ duration: 2939328000000000 }),
    [1050, 1050, 1050, 17.5, 1050]
  );

  assert.equal(plan.duration, 1050);
  assert.match(plan.evidence, /1050 × 60\^7/);
  assert.match(plan.evidence, /4 of 5 entry override/);
});

test("a plausible-looking rung is not enough on its own", () => {
  // The trap this module exists for. 63000 is a rung, and 63000 minutes is
  // inside the games band — "divide until it looks fine" writes 1,050 *hours*.
  const plan = planDurationRepair(GAMES, work({ duration: 2939328000000000 }), []);

  assert.equal(plan.duration, undefined);
  assert.match(plan.blocked, /no entry override matches/);
  assert.ok(plan.ladder.includes(63000));
});

test("an override that is not on the ladder does not authorise a write", () => {
  // 17.5 is what 1050 minutes looks like to someone typing hours. It is not a
  // rung — 1050/60 is not an integer — so it cannot pick the value.
  const plan = planDurationRepair(GAMES, work({ duration: 2939328000000000 }), [17.5]);

  assert.equal(plan.duration, undefined);
  assert.deepEqual(plan.overrides, [17.5]);
});

test("an override agreeing with the stored value repairs nothing", () => {
  // A Killer Paradox: 425 stored, 425 overridden, no ladder. Real, wrong, and
  // not ours to guess at.
  const plan = planDurationRepair(TV, work({ duration: 425 }), [425]);

  assert.equal(plan.duration, undefined);
  assert.match(plan.blocked, /not a multiple of 60/);
});

test("a corroborated rung above the ceiling is still refused", () => {
  // Overrides are user data, not authority to write an impossible number.
  const plan = planDurationRepair(GAMES, work({ duration: 2939328000000000 }), [
    3780000,
  ]);

  assert.equal(plan.duration, undefined);
});

test("the fewest undone multiplications win when two rungs are corroborated", () => {
  // A film, because 3,600 minutes is an impossible runtime and a perfectly
  // ordinary game. Its ladder is [60, 1] and both are inside the film band, so
  // the overrides are what separate them.
  const plan = planDurationRepair(FILMS, work({ duration: 3600 }), [60, 1]);

  assert.equal(plan.duration, 60);
});

///////////////////////////////////////////////////////////////////////////////
// The whole collection

test("a clean collection plans nothing", () => {
  const plan = planDurationRepairs(
    FILMS,
    [work({ duration: 111 }), work({ _id: "w2", duration: 299 })],
    new Map()
  );

  assert.deepEqual(plan.repair, []);
  assert.deepEqual(plan.needsHuman, []);
  assert.equal(plan.checked, 2);
});

test("findings are split by whether they can be acted on", () => {
  const works = [
    work({ duration: 2939328000000000 }),
    work({ _id: "w2", englishTranslatedTitle: "Mystery", duration: 999999 }),
    work({ _id: "w3", duration: 660 }),
  ];
  const plan = planDurationRepairs(
    GAMES,
    works,
    new Map([["w1", [1050]]])
  );

  assert.deepEqual(
    plan.repair.map((f) => [f.id, f.duration]),
    [["w1", 1050]]
  );
  assert.deepEqual(plan.needsHuman.map((f) => f.id), ["w2"]);
});

test("overrides are collected by the work they point at", () => {
  const byWorkRef = durationOverridesByWorkRef([
    { workRef: "w1", overrides: { duration: 1050 } },
    { workRef: "w1", overrides: { duration: 17.5 } },
    { workRef: "w1" },
    { workRef: "w2", overrides: { duration: "1050" } },
    // A user-authored entry with no work to point at (see audit_report.js).
    { overrides: { duration: 90 } },
  ]);

  assert.deepEqual(byWorkRef.get("w1"), [1050, 17.5]);
  assert.equal(byWorkRef.get("w2"), undefined);
  assert.equal(byWorkRef.size, 1);
});
