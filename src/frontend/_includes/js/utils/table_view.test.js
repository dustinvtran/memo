/**
 * @file What a cell draws, and what it draws when its formatter throws.
 *
 * `table_view.js` is the half of a list table that touches an element, so most
 * of it needs a DOM and is not asserted here. `cellContent` is the exception:
 * it is reached from `draw` on every cell of every redraw, it is where a
 * formatter's output becomes markup, and it is pure. `chrome` is the other
 * one, and the part of it worth pinning is the scroll region's name. The sort
 * headings and the comment caret are the last, because what they tell a
 * keyboard and a screen reader is markup and nothing else — see the tests at
 * the foot of this file. Loaded the way `columns.test.js` and
 * `table_model.test.js` load theirs — the frontend is
 * plain globals concatenated into a bundle rather than modules, so this runs
 * the source in a vm context holding the globals it expects, and pulls the
 * function out of the file's scope rather than off `TableView`.
 *
 * The real `Utils` and `TableModel`, because `EMPTY_CELL` and `valueAt` are
 * half of what is being asked about and a stand-in would be testing the
 * stand-in. `Icons` is real for the same reason `columns.test.js` uses it, and
 * `entry_search.js` because `table_model.js` reads it at load.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

// A console that records rather than prints: a formatter throwing has to stay
// visible, and "stays visible" is an assertion rather than a comment.
const errors = [];
const recordingConsole = {
  ...console,
  error: (...args) => errors.push(args),
};

const context = vm.createContext({ URL, console: recordingConsole });
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(read("general.js"), "undefined");
load(read("icons.js"), "undefined");
load(read("entry_search.js"), "undefined");
load(read("table_model.js"), "undefined");

const { cellContent, chrome, headerCell, caretCell, detailRow } = load(
  read("table_view.js"),
  "({ cellContent, chrome, headerCell, caretCell, detailRow })"
);

const draw = (column, row) => String(cellContent(column, row, 0));

test("a column with no formatter draws the value it names", () => {
  assert.equal(
    draw({ field: "commonMetadata.releaseYear" }, { commonMetadata: { releaseYear: 1998 } }),
    "1998"
  );
});

test("a value that isn't there draws a dash", () => {
  assert.equal(draw({ field: "commonMetadata.duration" }, { commonMetadata: {} }), "-");
});

test("a formatter answering with nothing draws a dash", () => {
  assert.equal(draw({ field: "x", formatter: () => undefined }, {}), "-");
  assert.equal(draw({ field: "x", formatter: () => null }, {}), "-");
});

test("a formatter that throws costs its cell and nothing else", () => {
  // Without this, one cell costs the table. `draw` in `table_view.js` builds
  // the entire `<tbody>` as one template string before assigning it, so a
  // throw anywhere in it means `grid.innerHTML` is never reached: the rows on
  // screen stay the ones from before the redraw, while the state that caused
  // the throw is already committed — so every later search, sort and toggle
  // rebuilds through the same cell and throws again. That is #292, where
  // ticking Publishers on a books list killed the sublist until reload.
  errors.length = 0;

  const column = {
    field: "commonMetadata.publishers",
    formatter: () => {
      throw new TypeError("(val ?? []).reduce is not a function");
    },
  };

  assert.equal(draw(column, { dbRef: "abc" }), "-");
  assert.equal(errors.length, 1);
});

test("what the cell logs names the column and the entry", () => {
  // A dash the reader can see and nothing in the console is how a bad shape
  // stays undiscovered. The message has to say which column and which entry,
  // or it cannot be chased back to a document.
  errors.length = 0;

  const thrown = new TypeError("nope");
  draw(
    {
      field: "commonMetadata.publishers",
      formatter: () => {
        throw thrown;
      },
    },
    { dbRef: "651f0c" }
  );

  const [message, error] = errors[0];
  assert.match(message, /commonMetadata\.publishers/);
  assert.match(message, /651f0c/);
  assert.equal(error, thrown);
});

test("the neighbouring cells in the same row still draw", () => {
  // The point of catching: the row survives its worst column.
  const row = { dbRef: "abc", commonMetadata: { releaseYear: 1998 } };
  const bad = {
    field: "commonMetadata.publishers",
    formatter: () => {
      throw new TypeError("nope");
    },
  };
  const good = { field: "commonMetadata.releaseYear" };

  assert.equal(draw(bad, row), "-");
  assert.equal(draw(good, row), "1998");
});

///////////////////////////////////////////////////////////////////////////////
// The scroll region, which is #400.

const drawChrome = (options) => String(chrome({}, options));

test("a named table's scroll region is focusable and says what it is", () => {
  // The wrapper scrolls sideways on a phone, and a scrolling box nothing can
  // focus is a set of columns only a pointer can reach.
  const markup = drawChrome({ label: "Completed" });

  assert.match(markup, /class="entry-table-scroll" tabindex="0"/);
  assert.match(markup, /role="region"/);
  assert.match(markup, /aria-label="Completed table"/);
});

test("a table with no name gets no tab stop either", () => {
  // The two halves of the fix are one thing: a focusable `div` with no
  // accessible name announces nothing when it is tabbed to, which is worse
  // than the scroll region nobody could reach. So a caller that forgets the
  // name does not get the `tabindex` on its own.
  const markup = drawChrome({});

  assert.match(markup, /<div class="entry-table-scroll">/);
  assert.ok(!markup.includes("tabindex"));
  assert.ok(!markup.includes("role="));
});

test("the name is escaped like any other attribute value", () => {
  // It comes from `conversions.js` today rather than from a document, so this
  // is the guard rather than the bug — an attribute built by hand out of a
  // template is exactly where the next one stops being true.
  const markup = drawChrome({ label: '" onfocus="alert(1)' });

  assert.ok(!markup.includes('onfocus="alert(1)"'));
  assert.match(markup, /aria-label="&quot; onfocus=&quot;alert\(1\) table"/);
});

///////////////////////////////////////////////////////////////////////////////
// The sort headings, which are #484.

const { TableModel, Icons } = vm.runInContext("({ TableModel, Icons })", context);
const columns = [
  { field: "title", title: "Title", sortable: true },
  { field: "score", title: "Score", sortable: true },
  { field: "notes", title: "Notes" },
];
const sortedBy = (sortField, sortOrder) =>
  TableModel.table({ columns, sortField, sortOrder });

const drawHeading = (field, state) =>
  String(headerCell(state.columns.find((column) => column.field === field), state));

test("a sortable heading's label is a button a keyboard can reach", () => {
  // A `th` with a click handler is a control only a pointer can use. The
  // button is what Tab stops on, and its Enter and Space arrive at the table's
  // click handler as the same click a mouse sends.
  const markup = drawHeading("title", sortedBy("score", "desc"));

  assert.match(markup, /<th[^>]*class="sortable"[^>]*><button type="button">Title<\/button><\/th>/);
});

test("the sorted heading says which way, and the other sortable ones say none", () => {
  assert.match(drawHeading("score", sortedBy("score", "desc")), /aria-sort="descending"/);
  assert.match(drawHeading("score", sortedBy("score", "asc")), /aria-sort="ascending"/);
  assert.match(drawHeading("title", sortedBy("score", "desc")), /aria-sort="none"/);
});

test("a heading that cannot be sorted has no button and no aria-sort", () => {
  // `aria-sort="none"` claims the column could be sorted, and a button on it
  // would be a tab stop that does nothing.
  const markup = drawHeading("notes", sortedBy("score", "desc"));

  assert.ok(!markup.includes("<button"));
  assert.ok(!markup.includes("aria-sort"));
  assert.match(markup, />Notes<\/th>/);
});

///////////////////////////////////////////////////////////////////////////////
// The comment caret, which is #485.

const row = { dbRef: "651f0c" };
const shut = TableModel.table({ columns });
const open = TableModel.withExpanded(shut, row.dbRef, true);

test("the caret is a button, not a link that goes nowhere", () => {
  const markup = String(caretCell(row, shut));

  assert.match(markup, /<button\s+type="button"\s+class="detail-icon"/);
  assert.ok(!markup.includes("href"));
  assert.match(markup, /aria-label="Comments"/);
  assert.match(markup, /data-ref="651f0c"/);
});

test("the caret says whether its panel is open", () => {
  // The swapped icon was the only sign, and it is `aria-hidden`.
  assert.match(String(caretCell(row, shut)), /aria-expanded="false"/);
  assert.match(String(caretCell(row, open)), /aria-expanded="true"/);
});

test("the caret keeps drawing the icon for its state", () => {
  const glyph = (name) => String(Icons.icon(name));

  assert.ok(String(caretCell(row, shut)).includes(glyph("caret-down")));
  assert.ok(String(caretCell(row, open)).includes(glyph("caret-up")));
});

test("the caret's aria-controls is the id its panel is drawn with", () => {
  const controls = String(caretCell(row, open)).match(/aria-controls="([^"]+)"/)[1];
  const panel = String(detailRow(row, 0, open, { detailFormatter: () => "" }));

  assert.match(panel, new RegExp(`<tr class="detail-view" id="${controls}"`));
});
