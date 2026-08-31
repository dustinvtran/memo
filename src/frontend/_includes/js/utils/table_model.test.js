/**
 * @file What a list table decides, asserted without a DOM — which is the whole
 * reason the decisions live in `table_model.js` rather than in the renderer
 * beside it. Nothing here needs an install, a browser or a network.
 *
 * Loaded the way `columns.test.js` and `tables.test.js` load theirs: the
 * frontend is plain globals concatenated into a bundle rather than modules, so
 * this runs the source in a vm context holding the globals it expects.
 * `entry_search.js` is the real one, because which rows survive a search is
 * half of what is being asked about here and a stand-in would be testing the
 * stand-in.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

const context = vm.createContext({ console });
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(read("entry_search.js"), "undefined");
load(read("table_model.js"), "undefined");

const {
  table,
  withSearch,
  withSortOn,
  withColumn,
  withExpanded,
  isExpanded,
  visibleColumns,
  switchableColumns,
  visibleRows,
  freeTextFields,
  noMatchesText,
  valueAt,
} = context.TableModel;

/** The columns a film list draws, cut down to the ones the tests ask about. */
const COLUMNS = [
  { title: "#", field: "#", visible: false, searchable: false },
  { title: "Title", field: "commonMetadata.englishTranslatedTitle", sortable: true },
  { title: "Score", field: "score", sortable: true },
  { title: "Director", field: "commonMetadata.directors", sortable: true },
  { title: "Actors", field: "commonMetadata.actors", sortable: true, visible: false },
];

const entry = (englishTranslatedTitle, extra = {}) => ({
  dbRef: englishTranslatedTitle.toLowerCase().replace(/\W+/g, "-"),
  score: extra.score,
  commonMetadata: {
    englishTranslatedTitle,
    releaseYear: extra.releaseYear,
    directors: extra.directors,
    actors: extra.actors,
  },
});

const ROWS = [
  entry("Blade Runner 2049", { score: 9, directors: ["Denis Villeneuve"] }),
  entry("Goldfinger", { score: 7, actors: ["Margaret Nolan"] }),
  entry("Inception", { score: 10, directors: ["Christopher Nolan"] }),
  entry("Tenet", { directors: ["Christopher Nolan"] }),
];

const state = (overrides = {}) =>
  table({ columns: COLUMNS, rows: ROWS, ...overrides });

/**
 * `[...]` on the way out of every one of these: the module under test runs in
 * its own vm realm, so an array it built has a different `Array.prototype` and
 * `deepStrictEqual` refuses it against a literal here — "same structure but not
 * reference-equal", about two empty arrays. Copying with a host literal is what
 * brings the value back into this realm.
 */
const titlesOf = (rows) =>
  [...rows].map((row) => row.commonMetadata.englishTranslatedTitle);

const drawn = (current) => titlesOf(visibleRows(current).rows);

const opened = (current) => [...current.expanded];

///////////////////////////////////////////////////////////////////////////////
// Sorting.

test("a list opens in the order it was asked for, score first", () => {
  assert.deepEqual(
    drawn(state({ sortField: "score", sortOrder: "desc" })),
    ["Inception", "Blade Runner 2049", "Goldfinger", "Tenet"]
  );
});

test("scores compare as numbers, so 10 is above 9", () => {
  // The string comparison this replaced put "10" between "1" and "2".
  const sorted = drawn(state({ sortField: "score", sortOrder: "desc" }));
  assert.equal(sorted[0], "Inception");
});

test("an entry with no score sorts last descending and first ascending", () => {
  // The Planned sublist is almost entirely this case: a score there is a
  // preference and hardly anything carries one.
  assert.equal(drawn(state({ sortField: "score", sortOrder: "desc" })).pop(), "Tenet");
  assert.equal(drawn(state({ sortField: "score", sortOrder: "asc" }))[0], "Tenet");
});

test("clicking a column the table is not sorted by starts it ascending", () => {
  const sorted = withSortOn(state({ sortField: "score", sortOrder: "desc" }), "score");
  assert.equal(sorted.sortOrder, "asc");

  const byTitle = withSortOn(sorted, "commonMetadata.englishTranslatedTitle");
  assert.equal(byTitle.sortOrder, "asc");
  assert.deepEqual(drawn(byTitle), [
    "Blade Runner 2049",
    "Goldfinger",
    "Inception",
    "Tenet",
  ]);
});

test("clicking the column it is already sorted by flips the order", () => {
  const once = withSortOn(state(), "score");
  assert.equal(once.sortOrder, "asc");
  assert.equal(withSortOn(once, "score").sortOrder, "desc");
  assert.equal(withSortOn(withSortOn(once, "score"), "score").sortOrder, "asc");
});

test("the sort is stable, so the order it was handed decides ties", () => {
  // `components/list/list.js` sorts alphabetically before the table sees the
  // rows, and that is what decides the order within one score — the whole of
  // the order in a Planned sublist.
  const tied = [entry("Zodiac", { score: 5 }), entry("Akira", { score: 5 })];
  const sorted = visibleRows(
    table({ columns: COLUMNS, rows: tied, sortField: "score", sortOrder: "desc" })
  ).rows;
  assert.deepEqual(titlesOf(sorted), ["Zodiac", "Akira"]);
});

test("sorting does not reorder the array it was given", () => {
  // Every sublist on a page is a slice of one array of entries, and `sort` is
  // in place.
  const rows = [...ROWS];
  visibleRows(table({ columns: COLUMNS, rows, sortField: "score", sortOrder: "asc" }));
  assert.deepEqual(titlesOf(rows), titlesOf(ROWS));
});

test("a field nothing holds sorts nothing rather than throwing", () => {
  // `#` and the edit button name no field on the row.
  assert.deepEqual(drawn(state({ sortField: "editCol" })), titlesOf(ROWS));
  assert.equal(valueAt({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(valueAt({}, "a.b.c"), undefined);
  assert.equal(valueAt(undefined, "score"), undefined);
});

///////////////////////////////////////////////////////////////////////////////
// Searching, and the columns it is run against.

test("a bare term is tried against the columns the table is showing", () => {
  // Goldfinger's only Nolan is Margaret Nolan, in the hidden cast column, and
  // a row that matches on something the reader cannot see reads as a bug.
  assert.deepEqual(drawn(withSearch(state(), "nolan")), ["Inception", "Tenet"]);
});

test("unhiding a column widens the same search immediately", () => {
  const searched = withSearch(state(), "nolan");
  const withActors = withColumn(searched, "commonMetadata.actors", true);

  assert.deepEqual(drawn(withActors), ["Goldfinger", "Inception", "Tenet"]);
});

test("hiding a column narrows it again", () => {
  const searched = withSearch(state(), "villeneuve");
  assert.deepEqual(drawn(searched), ["Blade Runner 2049"]);

  const hidden = withColumn(searched, "commonMetadata.directors", false);
  assert.deepEqual(drawn(hidden), []);
});

test("a column carrying none of the entry is never searched", () => {
  // `#` is a row number and the edit button is a hex id; a row matching on
  // either would be matching on nothing anybody typed.
  const shown = withColumn(state(), "#", true);
  assert.equal(
    freeTextFields(shown).length,
    freeTextFields(state()).length,
    "showing the # column added a field to search"
  );
});

test("a field term still names its own field, shown or not", () => {
  assert.deepEqual(drawn(withSearch(state(), "actor:nolan")), ["Goldfinger"]);
  assert.deepEqual(drawn(withSearch(state(), "director:nolan")), [
    "Inception",
    "Tenet",
  ]);
});

test("searching and sorting compose, in that order", () => {
  const searched = withSearch(
    state({ sortField: "score", sortOrder: "desc" }),
    "nolan"
  );
  assert.deepEqual(drawn(searched), ["Inception", "Tenet"]);
});

test("an empty query is every row", () => {
  assert.deepEqual(drawn(withSearch(state(), "")), titlesOf(ROWS));
});

test("a search that gave up is told apart from one that found nothing", () => {
  // #228: a pattern that backtracks is abandoned rather than run to the end,
  // and an empty list nobody explains looks exactly like a search that matched
  // nothing.
  assert.equal(noMatchesText(false), "No matching records found");
  assert.match(noMatchesText(true), /too slow/);

  const found = visibleRows(withSearch(state(), "nothing matches this"));
  assert.deepEqual([...found.rows], []);
  assert.equal(found.abandoned, false);
});

///////////////////////////////////////////////////////////////////////////////
// Columns, and the panels.

test("a column hidden by default stays hidden until it is asked for", () => {
  assert.deepEqual(
    visibleColumns(state()).map((column) => column.title),
    ["Title", "Score", "Director"]
  );
  assert.deepEqual(
    switchableColumns(state()).map((column) => column.title),
    ["#", "Title", "Score", "Director", "Actors"]
  );
});

test("toggling a column on one table leaves the others alone", () => {
  // Every sublist builds its own columns, but they are the same objects if
  // nothing copies them, and four sublists would toggle together.
  const first = state();
  const second = state();
  withColumn(first, "commonMetadata.actors", true);

  assert.equal(
    visibleColumns(second).some((column) => column.title === "Actors"),
    false
  );
});

test("a row is opened and closed by its own id, not by its position", () => {
  const open = withExpanded(state(), "inception", true);
  assert.equal(isExpanded(open, "inception"), true);
  assert.equal(isExpanded(open, "tenet"), false);

  // Opening twice is opening once.
  assert.deepEqual(opened(withExpanded(open, "inception", true)), ["inception"]);
  assert.deepEqual(opened(withExpanded(open, "inception", false)), []);
});

test("redrawing the rows closes the panels, because a panel is a fetch", () => {
  // What is in a comment panel comes from the network rather than from the
  // row, so keeping one open across a redraw would mean re-fetching it on
  // every keystroke. bootstrap-table closed them too.
  const open = withExpanded(state(), "inception", true);

  assert.deepEqual(opened(withSearch(open, "nolan")), []);
  assert.deepEqual(opened(withSortOn(open, "score")), []);
  assert.deepEqual(opened(withColumn(open, "commonMetadata.actors", true)), []);
});

test("every transition answers with a new state rather than editing one", () => {
  const before = state({ sortField: "score", sortOrder: "desc" });
  const after = withSortOn(withSearch(withExpanded(before, "tenet", true), "a"), "score");

  assert.equal(before.searchText, "");
  assert.equal(before.sortOrder, "desc");
  assert.deepEqual(opened(before), []);
  assert.notEqual(after, before);
});
