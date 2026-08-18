const { test } = require("node:test");
const assert = require("node:assert/strict");

const { FINDINGS, toSummary, countProblems } = require("./audit_report");

const GAMES = { type: "games", retrievePrefix: "igdb" };
const FILMS = { type: "films", retrievePrefix: "tmdb" };

const empty = Object.fromEntries(FINDINGS.map((f) => [f.key, []]));
const withCounts = (counts) => ({
  ...empty,
  ...Object.fromEntries(
    Object.entries(counts).map(([key, n]) => [key, Array.from({ length: n })])
  ),
});

const labelled = (lines) => lines.map((line) => line.key);
const countOf = (lines, key) => lines.find((l) => l.key === key)?.count;

test("an entry with no linked work is a note, not a problem", () => {
  const { problems, notes } = toSummary(
    FILMS,
    withCounts({ entriesWithoutWorkRef: 5 })
  );

  assert.ok(!labelled(problems).includes("entriesWithoutWorkRef"));
  assert.equal(countOf(notes, "entriesWithoutWorkRef"), 5);
});

test("an entry whose workRef names a missing work is a problem, and is listed first", () => {
  const { problems } = toSummary(
    FILMS,
    withCounts({ entriesWithDanglingWorkRef: 2 })
  );

  assert.equal(problems[0].key, "entriesWithDanglingWorkRef");
  assert.equal(problems[0].count, 2);
});

test("the two workRef findings never share a label", () => {
  const { problems, notes } = toSummary(FILMS, empty);
  const dangling = problems.find((l) => l.key === "entriesWithDanglingWorkRef");
  const missing = notes.find((l) => l.key === "entriesWithoutWorkRef");

  assert.notEqual(dangling.label, missing.label);
  // The pair that was misread: neither label may be a prefix of the other,
  // which is what "entries with no workRef" / "entries with a dangling
  // workRef" amounted to at a glance.
  assert.ok(!dangling.label.startsWith(missing.label));
  assert.ok(!missing.label.startsWith(dangling.label));
});

test("the playtime finding belongs to games and to nothing else", () => {
  assert.ok(
    labelled(toSummary(GAMES, empty).problems).includes(
      "gamesMissingPlaytimeLink"
    )
  );
  assert.ok(
    !labelled(toSummary(FILMS, empty).problems).includes(
      "gamesMissingPlaytimeLink"
    )
  );
});

test("the apiRef label names the prefix the type is refreshed by", () => {
  const labelFor = (collection) =>
    toSummary(collection, empty).problems.find((l) => l.key === "noApiRef")
      .label;

  assert.match(labelFor(GAMES), /igdb__/);
  assert.match(labelFor(FILMS), /tmdb__/);
});

test("a missing key counts as zero rather than throwing", () => {
  const { problems, notes } = toSummary(FILMS, {});

  assert.ok(problems.every((line) => line.count === 0));
  assert.ok(notes.every((line) => line.count === 0));
  assert.doesNotThrow(() => toSummary(FILMS, undefined));
});

test("notes are not counted as problems", () => {
  const report = {
    films: withCounts({ entriesWithoutWorkRef: 5, orphanWorks: 44 }),
    games: withCounts({ entriesWithoutWorkRef: 8, corruptFields: 3 }),
  };

  assert.equal(countProblems([FILMS, GAMES], report), 3);
});

test("every finding is one kind or the other, and no key repeats", () => {
  for (const finding of FINDINGS) {
    assert.ok(["problem", "note"].includes(finding.kind), finding.key);
    assert.equal(typeof finding.label(GAMES), "string");
  }

  assert.equal(new Set(FINDINGS.map((f) => f.key)).size, FINDINGS.length);
});
