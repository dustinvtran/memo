/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads profile_stats.js into a vm context with
 * the globals it expects and pulls the chart builders out of the script's
 * scope — the same trick as utils/columns.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "profile_stats.js"), "utf8");

// Stubs, not the real thing: nothing under test renders any markup or talks to
// Netlify. They exist because the file destructures all of these at load time,
// and because its last line writes itself onto `Components.Profile`.
//
// base.njk wraps each included file in its own IIFE, which is what keeps two
// files' `const`s from colliding and what makes an assignment with no keyword
// the only thing that crosses between them. Loading it the same way here keeps
// that difference visible.
const context = vm.createContext({
  Netlify: { entryTypes: [], getStats: () => {} },
  Tables: { col: () => {} },
  Conversions: { typeToTitle: {} },
  Utils: { html: () => "", css: () => "" },
  Components: {
    initComponent: () => {},
    WithRemoteData: () => {},
    UI: { Tabbed: () => {} },
    Profile: {},
  },
});

const { BUCKETS, toChartOptions, aggregateStats } = vm.runInContext(
  `(() => {\n${source}\n;return ({ BUCKETS, toChartOptions, aggregateStats })\n})()`,
  context
);

/** A full tally, one entry in each bucket, so a dropped bucket is visible. */
const oneOfEach = () =>
  Object.fromEntries(BUCKETS.map((bucket) => [bucket, 1]));

// Everything the script returns was built inside the vm's realm, against that
// realm's `Object` and `Array`. A strict deepEqual compares prototypes, so the
// results are copied back into this one before being asserted on.
const categories = (stats) => [...toChartOptions(stats).xaxis.categories];
const data = (stats) => [...toChartOptions(stats).series[0].data];
const totals = (stats) => ({ ...aggregateStats(stats) });

test("every bar has a label and every label has a bar", () => {
  // The bug: ten data points against eleven categories. ApexCharts pairs them
  // by index, so one short at the front slides every later bar under the wrong
  // label.
  const options = toChartOptions(oneOfEach());
  assert.equal(
    options.series[0].data.length,
    options.xaxis.categories.length
  );
  assert.equal(options.xaxis.categories.length, 11);
});

test("scores run 10 down to 1, with unrated last", () => {
  assert.deepEqual(
    categories(oneOfEach()),
    ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "Unrated"]
  );
});

test("a score of 1 reaches the chart", () => {
  // It was never read at all: entries scored 1 simply weren't drawn.
  const stats = { ...oneOfEach(), 1: 7 };
  assert.equal(data(stats)[categories(stats).indexOf("1")], 7);
});

test("the unrated tally is drawn under Unrated, not under 1", () => {
  const stats = { ...oneOfEach(), unrated: 42 };
  const drawn = data(stats);
  assert.equal(drawn[categories(stats).indexOf("Unrated")], 42);
  assert.equal(drawn[categories(stats).indexOf("1")], 1);
  assert.equal(drawn.at(-1), 42);
});

test("a bucket the user has none of is a zero bar, not a hole", () => {
  // The tally the API stores has all eleven keys, but a stats document written
  // before a bucket existed — or an empty one — may not, and `undefined` in a
  // series makes ApexCharts skip the bar and shift nothing, which is how this
  // stays invisible.
  assert.deepEqual(data({}), new Array(11).fill(0));
  assert.deepEqual(
    data({ 10: 3, unrated: 2 }),
    [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]
  );
});

///////////////////////////////////////////////////////////////////////////////
// The global chart is fed from aggregateStats rather than from a tally the API
// wrote, so it has to hold the same shape.

const scoresOf = (...types) => ({
  scores: Object.fromEntries(types.map((tally, i) => [i, tally])),
});

test("the global tally sums each bucket across the four types", () => {
  const summed = totals(
    scoresOf(oneOfEach(), oneOfEach(), oneOfEach(), oneOfEach())
  );
  assert.deepEqual(summed, Object.fromEntries(BUCKETS.map((b) => [b, 4])));
});

test("a type missing a bucket does not turn the total into NaN", () => {
  const summed = totals(scoresOf(oneOfEach(), { 10: 2 }, {}, {}));
  assert.equal(summed["10"], 3);
  assert.equal(summed["1"], 1);
  assert.equal(summed["unrated"], 1);
  assert.ok(
    Object.values(summed).every(Number.isFinite),
    `NaN in the global tally: ${JSON.stringify(summed)}`
  );
});

test("the global tally keeps all eleven buckets whatever it was given", () => {
  // It used to take its keys from whichever type came first, so a type missing
  // a bucket dropped that bucket from the chart entirely.
  assert.deepEqual(
    Object.keys(totals(scoresOf({}, {}, {}, {}))).sort(),
    [...BUCKETS].sort()
  );
});
