/**
 * @file What a cell draws, and what it draws when its formatter throws.
 *
 * `table_view.js` is the half of a list table that touches an element, so most
 * of it needs a DOM and is not asserted here. `cellContent` is the exception:
 * it is reached from `draw` on every cell of every redraw, it is where a
 * formatter's output becomes markup, and it is pure. Loaded the way
 * `columns.test.js` and `table_model.test.js` load theirs — the frontend is
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

const { cellContent } = load(read("table_view.js"), "({ cellContent })");

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
