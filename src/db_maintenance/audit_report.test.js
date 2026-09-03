const { test } = require("node:test");
const assert = require("node:assert/strict");

const { FINDINGS, toSummary, countProblems } = require("./audit_report");

const GAMES = { type: "games", retrievePrefix: "igdb" };
const FILMS = { type: "films", retrievePrefix: "tmdb" };
const TV = { type: "tv", retrievePrefix: "tmdb" };

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

test("a collision cannot be found in tv, so no zero is printed for it", () => {
  // TMDB has one id per show and the site tracks seasons separately, so a
  // shared show id is how tv works rather than something to drive to zero.
  assert.ok(
    labelled(toSummary(GAMES, empty).problems).includes("sharedIdentityRefs")
  );
  assert.ok(
    !labelled(toSummary(TV, empty).problems).includes("sharedIdentityRefs")
  );
});

test("the seasons line is a note, and belongs to tv alone", () => {
  const { problems, notes } = toSummary(TV, withCounts({ expectedSharedRefs: 19 }));

  assert.equal(countOf(notes, "expectedSharedRefs"), 19);
  assert.ok(!labelled(problems).includes("expectedSharedRefs"));
  assert.ok(
    !labelled(toSummary(GAMES, empty).notes).includes("expectedSharedRefs")
  );
});

test("the nineteen tv groups are no longer inside the headline number", () => {
  // What #290 opened with: 44 groups under one heading, of which 19 were
  // correct by design and could never be fixed.
  const report = {
    tv: withCounts({ expectedSharedRefs: 19 }),
    games: withCounts({ sharedIdentityRefs: 18 }),
  };

  assert.equal(countProblems([TV, GAMES], report), 18);
});

test("a duplicate and a collision are counted apart", () => {
  const { problems } = toSummary(
    GAMES,
    withCounts({ duplicateWorks: 2, sharedIdentityRefs: 18 })
  );

  assert.equal(countOf(problems, "duplicateWorks"), 2);
  assert.equal(countOf(problems, "sharedIdentityRefs"), 18);
  assert.notEqual(
    problems.find((l) => l.key === "duplicateWorks").label,
    problems.find((l) => l.key === "sharedIdentityRefs").label
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

/**
 * #327. The two buckets that stay refused are damage; the third is a stored
 * title somebody typed without its article, which the merge now forgives, so
 * it belongs with the tv seasons and the user-authored entries rather than in
 * a count a reader is meant to drive to zero.
 */
test("a title an id resolves to differently is a problem, a spelling is not", () => {
  const { problems, notes } = toSummary(
    FILMS,
    withCounts({ titleRefDifferent: 103, titleRefContained: 171, titleRefSpelling: 69 })
  );

  assert.equal(countOf(problems, "titleRefDifferent"), 103);
  assert.equal(countOf(problems, "titleRefContained"), 171);
  assert.equal(countOf(notes, "titleRefSpelling"), 69);
});

test("every finding is one kind or the other, and no key repeats", () => {
  for (const finding of FINDINGS) {
    assert.ok(["problem", "note"].includes(finding.kind), finding.key);
    assert.equal(typeof finding.label(GAMES), "string");
  }

  assert.equal(new Set(FINDINGS.map((f) => f.key)).size, FINDINGS.length);
});
