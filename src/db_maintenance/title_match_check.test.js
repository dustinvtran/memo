const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const { FINDINGS } = require("./audit_report");
const {
  TITLE_MATCH_BUCKETS,
  classifyTitleMatch,
  titleMatchTargets,
  resolveTitleMatch,
  classifyTitleMatches,
} = require("./title_match_check");

const films = COLLECTIONS.find((c) => c.type === "films");
const books = COLLECTIONS.find((c) => c.type === "books");

const titled = (title, extra) => ({
  _id: "a",
  englishTranslatedTitle: title,
  apiRefs: ["tmdb__37165"],
  ...extra,
});

/** The verdict on a stored title against the one its id turned out to name. */
const verdict = (stored, named) =>
  classifyTitleMatch(titled(stored), { englishTranslatedTitle: named });

///////////////////////////////////////////////////////////////////////////////
// The three buckets, and the line between the first two, which is the whole
// point of the module. #327.

test("an id that names what is filed under it is not a finding", () => {
  assert.equal(verdict("The Truman Show", "The Truman Show"), "same");
});

test("a difference the old spelling already forgave is still `same`", () => {
  // `normalizeTitle` has always dropped case and punctuation, so these were
  // never refused and #327 recovered nothing here. Reporting them as a
  // recovery would inflate the one number the issue is measured by.
  assert.equal(verdict("wall·e", "WALL-E"), "same");
});

test("the leading article #327 is named for is a spelling difference", () => {
  // 69 works are stored like this and have been unrefreshable since #290.
  assert.equal(verdict("Truman Show", "The Truman Show"), "spelling");
  assert.equal(
    verdict("Autopsy of Jane Doe", "The Autopsy of Jane Doe"),
    "spelling"
  );
});

test("a spelled-out number and its digit are the same title", () => {
  assert.equal(
    verdict("The Trial of the Chicago Seven", "The Trial of the Chicago 7"),
    "spelling"
  );
});

test("a series suffix in brackets is a spelling difference", () => {
  assert.equal(
    verdict("The Wonderful Wizard of Oz (Oz, #1)", "The Wonderful Wizard of Oz"),
    "spelling"
  );
});

test("a diacritic is a spelling difference, but only up to the subtitle", () => {
  assert.equal(verdict("Amélie", "Amelie"), "spelling");
  // `Salò, or the 120 Days of Sodom` is the same film as `Salo` and is *not*
  // the same string once the accent is gone: the subtitle is still there. It
  // moves from "different" to "contained", which is triage and not a merge.
  assert.equal(verdict("Salo", "Salò, or the 120 Days of Sodom"), "contained");
});

///////////////////////////////////////////////////////////////////////////////
// Containment is never agreement. This is the bucket the real misfilings live
// in, and a substring test would pass every one of them.

test("the misfilings from the issue are contained, and stay refused", () => {
  for (const [stored, named] of [
    ["House of Flying Daggers", "Making of House of Flying Daggers"],
    ["Ex Machina", "Digitaria Ex Machina"],
    ["X-Men: First Class", "X-Men: First Class 35mm Special"],
    ["Caught in the Web", "Kim Dotcom: Caught in the Web"],
  ]) {
    assert.equal(verdict(stored, named), "contained");
  }
});

test("an edition title lands in the same bucket, which is why it is triage", () => {
  // Nothing here separates this from the four above, and pretending otherwise
  // is what the bucket exists to avoid.
  assert.equal(
    verdict("Heart of Darkness", "Heart of Darkness By Joseph Conrad"),
    "contained"
  );
});

test("two letters inside a longer title are not containment", () => {
  // `up` is inside a great many titles. A pair this weak belongs in
  // "different", where a reader will look at it, rather than in the bucket
  // that means "these may well be one work".
  assert.equal(verdict("Up", "Supernatural"), "different");
});

test("a genuinely different title is different", () => {
  assert.equal(verdict("Pinnochio", "The Adventures of Buratino"), "different");
  assert.equal(
    verdict("Three Billboards Outside Ebbing", "The Origins of Ebbing"),
    "different"
  );
});

test("dropping the spaces can make a difference into a containment", () => {
  // #327 counts `Ghostrider` against `Ghost Rider 2 Goes Wild` among the
  // genuinely different, because as strings they are. Once the punctuation and
  // the spaces are gone one is a prefix of the other, so it lands in the
  // triage bucket instead — which is where a reader wants it: it is a
  // misfiling, and the contained bucket is the one that gets looked at.
  assert.equal(verdict("Ghostrider", "Ghost Rider 2 Goes Wild"), "contained");
});

test("an extra word in the middle is a difference, not containment", () => {
  // #327 lists this one as a near-miss the normalisation does not reach, and
  // it is worth pinning: `Texas Chainsaw 3D` is not a substring of the other.
  assert.equal(
    verdict("Texas Chainsaw Massacre 3D", "Texas Chainsaw 3D"),
    "different"
  );
});

test("either title of one may match either title of the other", () => {
  const work = {
    englishTranslatedTitle: "Spirited Away",
    originalTitle: "千と千尋の神隠し",
  };
  assert.equal(
    classifyTitleMatch(work, { englishTranslatedTitle: "千と千尋の神隠し" }),
    "same"
  );
});

test("no title on either side is not a verdict", () => {
  const named = { englishTranslatedTitle: "X" };
  assert.equal(classifyTitleMatch(titled(undefined), named), undefined);
  assert.equal(classifyTitleMatch(titled("X"), {}), undefined);
});

///////////////////////////////////////////////////////////////////////////////
// What gets asked, and what comes back

test("only works carrying the ref their type is retrieved by are asked", () => {
  const targets = titleMatchTargets(films, [
    titled("Alien"),
    titled("Aliens", { _id: "b", apiRefs: ["imdb__tt0090605"] }),
    titled("Alien 3", { _id: "c", apiRefs: undefined }),
    // A placeholder is not an identifier — 14 films carry `undefined__undefined`.
    titled("Alien Resurrection", { _id: "d", apiRefs: ["tmdb__undefined"] }),
  ]);

  assert.deepEqual(
    targets.map((t) => [t.work._id, t.apiRef, t.ref]),
    [["a", "tmdb__37165", "37165"]]
  );
});

test("a book is asked by its ISBN, whichever prefix also names it", () => {
  const targets = titleMatchTargets(books, [
    {
      _id: "a",
      englishTranslatedTitle: "Recursion",
      apiRefs: ["google__x", "ISBN__9781984880659"],
    },
  ]);

  assert.deepEqual(targets.map((t) => t.apiRef), ["ISBN__9781984880659"]);
});

test("a check carries the work, the id and what the id named", () => {
  const [target] = titleMatchTargets(films, [titled("Truman Show")]);
  const check = resolveTitleMatch(target, {
    englishTranslatedTitle: "The Truman Show",
  });

  assert.deepEqual(check, {
    id: "a",
    title: "Truman Show",
    apiRefs: ["tmdb__37165"],
    apiRef: "tmdb__37165",
    ref: "37165",
    apiTitle: "The Truman Show",
    verdict: "spelling",
  });
});

///////////////////////////////////////////////////////////////////////////////
// Splitting the answers

test("the checks are split by verdict, and non-answers by why", () => {
  const split = classifyTitleMatches([
    { verdict: "same" },
    { verdict: "spelling" },
    { verdict: "contained" },
    { verdict: "different" },
    { verdict: "different" },
    { error: "404 Not Found" },
    { verdict: undefined },
  ]);

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(split).map(([bucket, checks]) => [bucket, checks.length])
    ),
    {
      same: 1,
      spelling: 1,
      contained: 1,
      different: 2,
      unanswered: 1,
      uncompared: 1,
    }
  );
});

test("an id that could not be asked is never called a misfiling", () => {
  // "Google Books would not say" and "the ISBN names another book" are
  // different answers, and only the second is a finding. An error carries no
  // verdict, so folding it in by accident would put it in `same`.
  const { unanswered, same, different } = classifyTitleMatches([
    { error: "rate limited" },
  ]);

  assert.equal(unanswered.length, 1);
  assert.deepEqual([same, different], [[], []]);
});

///////////////////////////////////////////////////////////////////////////////

test("every bucket is a finding the summary knows how to label", () => {
  const known = new Set(FINDINGS.map((finding) => finding.key));
  for (const { key } of TITLE_MATCH_BUCKETS) {
    assert.ok(known.has(key), `${key} is printed but never summarised`);
  }
});
