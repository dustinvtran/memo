/**
 * @file Ranking and query-building for the ref proposals, with no network.
 *
 * Every case is one production actually produced.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { rankCandidates, scoreCandidate, queriesFor } = require("./work_ref_proposal");

const work = (englishTranslatedTitle, releaseYear) => ({ englishTranslatedTitle, releaseYear });

test("an exact title and year is the strongest match there is", () => {
  assert.equal(scoreCandidate(work("Hero", 2002), { title: "Hero", year: "2002" }), 100);
});

/**
 * Four Heroes come back and only the year tells them apart, which is the whole
 * reason the year is scored at all.
 */
test("the year separates works that share a title exactly", () => {
  const ranked = rankCandidates(work("Hero", 2002), [
    { ref: "10699", title: "Hero", year: "1992" },
    { ref: "79", title: "Hero", year: "2002" },
  ]);
  assert.equal(ranked[0].ref, "79");
});

/**
 * The bug this exists to prevent: a stored year is wrong about as often as a
 * stored title, and a penalty large enough to matter hid the one candidate
 * that was right about both. Stored 2019; the film is the 2017 one.
 */
test("a wrong stored year cannot sink a better title", () => {
  const ranked = rankCandidates(work("You Were Never Really There", 2019), [
    { ref: "1619701", title: "YOU WERE NEVER YOURS", year: null },
    { ref: "398181", title: "You Were Never Really Here", year: "2017" },
  ]);
  assert.equal(ranked[0].ref, "398181");
});

/**
 * `comparableTitle` strips spaces, so splitting it on one yields a single
 * enormous word and every overlap scored zero — which made a typo'd title
 * match nothing at all and read as "this film does not exist".
 */
test("overlapping words are counted as words", () => {
  assert.ok(
    scoreCandidate(work("You Were Never Really There"), { title: "You Were Never Really Here" }) > 0
  );
});

test("a candidate with no id is dropped; a weak one is not", () => {
  const ranked = rankCandidates(work("Hero", 2002), [
    { ref: "", title: "Hero", year: "2002" },
    { ref: "1", title: "Something Else Entirely", year: "1980" },
  ]);
  assert.deepEqual(ranked.map((c) => c.ref), ["1"]);
});

test("the same id twice is one candidate", () => {
  const ranked = rankCandidates(work("Hero"), [
    { ref: "79", title: "Hero", year: "2002" },
    { ref: "79", title: "Hero", year: "2002" },
  ]);
  assert.equal(ranked.length, 1);
});

test("titleAgrees answers the question the write will ask", () => {
  const [agreeing] = rankCandidates(work("Hero"), [{ ref: "79", title: "Hero" }]);
  assert.equal(agreeing.titleAgrees, true);

  const [differing] = rankCandidates(work("Doom mod: Sigil"), [{ ref: "1", title: "Sigil" }]);
  assert.equal(differing.titleAgrees, false);
});

test("both halves of a separated title are tried", () => {
  // `Red Cliff: Part One` is named by its first half, `Doom mod: Sigil` by its
  // second, so neither direction alone is enough.
  assert.ok(queriesFor("Red Cliff: Part One").includes("Red Cliff"));
  assert.ok(queriesFor("Doom mod: Sigil").includes("Sigil"));
});

test("the last word is dropped, which is what rescues a typo", () => {
  assert.ok(queriesFor("You Were Never Really There").includes("You Were Never Really"));
});

test("a query is never shortened below two words", () => {
  assert.deepEqual(queriesFor("Hero"), ["Hero"]);
  assert.ok(queriesFor("The Villainness").every((q) => q.split(" ").length >= 2 || q === "The Villainness"));
});

test("diacritics and punctuation get a plain variation", () => {
  assert.ok(queriesFor("Pôther Pãchali").includes("Pother Pachali"));
});

test("nothing is returned for nothing", () => {
  assert.deepEqual(queriesFor(""), []);
  assert.deepEqual(queriesFor(undefined), []);
  assert.deepEqual(rankCandidates(work("A"), undefined), []);
});
