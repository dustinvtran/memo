/**
 * @file Reading a `--works` file for propose_work_refs.js, with no database.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseNamedWorks, unmatchedNamed } = require("./named_works");

test("a bare list of ids is read as it stands", () => {
  assert.deepEqual(parseNamedWorks(["a1", "b2"]), ["a1", "b2"]);
});

test("rows carrying `work` or `id` are both read", () => {
  assert.deepEqual(parseNamedWorks([{ kind: "work", work: "a1" }, { id: "b2" }]), [
    "a1",
    "b2",
  ]);
});

test("an id named twice is searched once", () => {
  assert.deepEqual(parseNamedWorks(["a1", { work: "a1" }, "b2"]), ["a1", "b2"]);
});

/**
 * #468's case. This used to become the string "undefined", match nothing, and
 * finish as an empty run that looked clean.
 */
test("a row with neither `work` nor `id` is refused, by position", () => {
  assert.throws(
    () => parseNamedWorks([{ work: "a1" }, { workId: "abc" }]),
    /row 1 \(\{"workId":"abc"\}\) carries no work id/
  );
});

test("empty and placeholder ids are refused rather than searched", () => {
  for (const row of ["", "  ", null, { work: "" }, { id: "undefined" }, { work: null }]) {
    assert.throws(() => parseNamedWorks([row]), /carries no work id/, JSON.stringify(row));
  }
});

test("an entry row from this script's own output is refused as an entry", () => {
  assert.throws(
    () => parseNamedWorks([{ kind: "entry", type: "films", entry: "e1" }]),
    /is an entry, not a work/
  );
});

/** `audit_database.js --json` is an object keyed by collection; `.map` threw on it. */
test("an audit report yields its different and contained titles", () => {
  const audit = {
    films: {
      works: 3,
      titleRefSpelling: [{ id: "spelled" }],
      titleRefContained: [{ id: "f2", title: "Making of House of Flying Daggers" }],
      titleRefAlternate: [{ id: "alternate" }],
      titleRefDifferent: [{ id: "f1", title: "Pinnochio" }],
    },
    games: {
      titleRefContained: [],
      titleRefDifferent: [{ id: "g1" }],
    },
  };
  assert.deepEqual(parseNamedWorks(audit), ["f1", "f2", "g1"]);
});

test("an audit written without --verify-titles is refused as naming nothing", () => {
  assert.throws(
    () => parseNamedWorks({ films: { titleRefContained: [], titleRefDifferent: [] } }),
    /names no works.*--verify-titles/
  );
});

test("a malformed row inside an audit section says which section", () => {
  assert.throws(
    () => parseNamedWorks({ films: { titleRefContained: [], titleRefDifferent: [{}] } }),
    /films\.titleRefDifferent: row 0/
  );
});

test("an object that is not an audit report is refused", () => {
  assert.throws(() => parseNamedWorks({ ids: ["a1"] }), /not an audit_database\.js --json report/);
  assert.throws(() => parseNamedWorks({}), /not an audit_database\.js --json report/);
});

test("a scalar is refused", () => {
  assert.throws(() => parseNamedWorks("a1"), /must hold a JSON list/);
  assert.throws(() => parseNamedWorks(null), /must hold a JSON list/);
});

test("an empty list is refused", () => {
  assert.throws(() => parseNamedWorks([]), /names no works/);
});

test("every named id that matched no work is reported, in the order named", () => {
  assert.deepEqual(unmatchedNamed(["a1", "stale", "b2", "gone"], new Set(["b2", "a1"])), [
    "stale",
    "gone",
  ]);
  assert.deepEqual(unmatchedNamed(["a1"], ["a1"]), []);
});
