/**
 * @file The expanded row's comment panel, which used to be drawn by an inline
 * `<script>` that jQuery evaluated on its way into the DOM. `script-src` in
 * `_headers` grants neither `'unsafe-inline'` nor `'unsafe-eval'`, so
 * enforcing that header would have meant a spinner and never a note, on every
 * row of every list, for every visitor (#219).
 *
 * What replaces it is two halves that have to agree: markup that names the
 * entry in `data-` attributes, and a handler bound to `document` that reads
 * them back. Both halves are asserted here, against each other.
 *
 * Loaded the way `columns.test.js` loads its file — the frontend is plain
 * globals concatenated into a bundle rather than modules, so this runs the
 * source in a vm context holding the globals it expects.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "tables.js"), "utf8");
const generalSource = fs.readFileSync(path.join(__dirname, "general.js"), "utf8");

// The real `Utils`, because `escapeHtml` is what the attributes below are
// being asked about and a stand-in for it would be testing the stand-in. No
// `window`: the file used to hang bootstrap-table's `customSearch` off it,
// because 1.12 resolved that option as a global name, and 1.21 takes the
// function itself.
const context = vm.createContext({
  URL,
  console,
  Conversions: { apiTypeToType: { Game: "games" } },
});
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(generalSource, "undefined");

const { detailFormatter, includeReviewIn } = load(
  source,
  "({ detailFormatter, includeReviewIn })"
);

const row = (dbRef = "abc") => ({
  dbRef,
  commonMetadata: { entryType: "Game", imageUrl: undefined },
});

test("the expanded row names its entry rather than carrying a script", () => {
  const rendered = detailFormatter(null, row());

  assert.ok(rendered.includes('data-review-ref="abc"'));
  assert.ok(rendered.includes('data-review-type="games"'));
  assert.doesNotMatch(rendered, /<script/i);
  assert.doesNotMatch(rendered, /\son[a-z]+=/i);
});

test("an id in the panel is escaped like any other attribute value", () => {
  const rendered = detailFormatter(null, row(`a"b'c`));

  assert.ok(rendered.includes(`data-review-ref="a&quot;b&#39;c"`));
});

test("the handler asks for the review the panel names", () => {
  const panel = { dataset: { reviewType: "games", reviewRef: "abc" } };
  const detailCell = { it: "the td the detail view was appended to" };
  const searched = [];
  const asked = [];
  const filled = [];

  context.$ = (target) => ({
    find: (selector) => {
      searched.push([target, selector]);
      return [panel];
    },
  });
  context.Netlify = {
    getReview: (type, entryId) => {
      asked.push([type, entryId]);
      return Promise.resolve();
    },
  };
  context.Components = {
    setContent: (target, component) => filled.push([target, component]),
    WithRemoteData: (args) => args,
    Markdown: (text) => text,
  };

  includeReviewIn(detailCell);

  assert.deepEqual(searched, [[detailCell, "[data-review-ref]"]]);
  assert.deepEqual(asked, [["games", "abc"]]);
  assert.equal(filled.length, 1);
  // The panel itself, not a selector built from the id it holds.
  assert.equal(filled[0][0], panel);
});

test("the attribute the handler looks for is the one the markup writes", () => {
  // The two halves are in one file and still a rename could take only one of
  // them, which would be a comment panel that spins for ever.
  const panel = { dataset: { reviewType: "games", reviewRef: "abc" } };
  let selector;

  context.$ = () => ({
    find: (used) => {
      selector = used;
      return [panel];
    },
  });

  includeReviewIn({});

  const attribute = selector.replace(/[[\]]/g, "");
  assert.ok(detailFormatter(null, row()).includes(`${attribute}="abc"`));
});

test("a detail view with no panel in it asks for nothing", () => {
  context.$ = () => ({ find: () => [] });
  context.Netlify = {
    getReview: () => assert.fail("asked for a review with no panel to put it in"),
  };

  assert.doesNotThrow(() => includeReviewIn({}));
});
