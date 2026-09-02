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

/**
 * The script in a context of its own, with a record of what it asked the page
 * and the loader for.
 *
 * Most of the context is stubs, not the real thing: nothing under test renders
 * any markup or talks to Netlify. They exist because the file destructures all
 * of these at load time, and because its last line writes itself onto
 * `Components.Profile`.
 *
 * `wrapInIife` in `asset_plan.js` wraps each bundled file in its own IIFE,
 * which is what keeps two files' `const`s from colliding and what makes an
 * assignment with no keyword the only thing that crosses between them. Loading
 * it the same way here keeps that difference visible.
 */
const load = () => {
  const state = {
    /** Asks for ApexCharts. Zero of them means nothing tried to draw. */
    loads: 0,
    rendered: [],
    containers: new Map(),
    errors: [],
  };

  const ApexCharts = function (element, options) {
    this.render = () => state.rendered.push({ element, options });
  };

  const context = vm.createContext({
    Netlify: { entryTypes: [], getStats: () => {} },
    Conversions: { typeToTitle: {} },
    Utils: {
      html: () => "",
      css: () => "",
      timeAgo: () => "",
      dateTime: () => "",
    },
    // ApexCharts is fetched on demand, so `drawChart` is asynchronous and the
    // ask is the first thing it does. Counting the asks is how the tests below
    // tell a chart that was drawn from one that was not.
    LoadScript: {
      loadApexCharts: () => {
        state.loads += 1;
        return Promise.resolve(ApexCharts);
      },
    },
    document: {
      querySelector: (selector) => state.containers.get(selector) ?? null,
    },
    console: { error: (message) => state.errors.push(message) },
    Components: {
      // Handed straight back rather than swallowed: what the tests need is the
      // initializer, and `content` and `style` are never called.
      initComponent: (component) => component,
      WithRemoteData: () => {},
      UI: { Tabbed: () => {} },
      Profile: {},
    },
  });

  const exports = vm.runInContext(
    `(() => {\n${source}\n;return ({ BUCKETS, toChartOptions, aggregateStats, GlobalStats, once })\n})()`,
    context
  );

  return { ...exports, state };
};

const { BUCKETS, toChartOptions, aggregateStats } = load();

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

test("the timestamp beside the scores is not counted as a fifth type", () => {
  // `GET /api/stats/:username` answers with `{ scores, updatedDate }` on both
  // of its paths as of #145, where a recompute used to answer with `{ scores }`
  // alone. The global chart sums `Object.values(stats.scores)`; were it ever
  // to sum `Object.values(stats)`, the timestamp would be read as a tally and
  // every bucket would come back `undefined`.
  const stats = {
    ...scoresOf(oneOfEach(), oneOfEach(), oneOfEach(), oneOfEach()),
    updatedDate: 1700000000000,
  };

  assert.deepEqual(
    totals(stats),
    Object.fromEntries(BUCKETS.map((b) => [b, 4]))
  );
});

///////////////////////////////////////////////////////////////////////////////
// When the global chart draws, which is the whole of #282. It is the second
// page of `Tabbed`, so its container is `display: none` when its initializer
// runs and `.render()` would measure a width of zero and keep it.

/** Only the first call of a `once` does anything. */
test("once runs the first call and swallows the rest", () => {
  const { once } = load();
  const calls = [];
  const record = once((n) => calls.push(n));

  record(1);
  record(2);
  record(3);

  assert.deepEqual([...calls], [1]);
});

test("once passes the first call's arguments through", () => {
  const { once } = load();
  let seen;
  once((...args) => {
    seen = args.join(",");
  })("a", "b");

  assert.equal(seen, "a,b");
});

test("a once that throws is still spent", () => {
  // Not a design goal so much as a fact worth pinning: `drawChart` catches its
  // own failures, so nothing reaches here, and a `once` that reset itself on a
  // throw would be a retry loop bound to however many times a tab is clicked.
  const { once } = load();
  let calls = 0;
  const boom = once(() => {
    calls += 1;
    throw new Error("no");
  });

  assert.throws(boom);
  boom();

  assert.equal(calls, 1);
});

/** A container the browser has measured, as far as `drawChart` looks at one. */
const aVisibleContainer = () => ({
  isConnected: true,
  offsetWidth: 392,
  getClientRects: () => [{}],
});

/** `drawChart` awaits the loader and then the layout; both settle as microtasks. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const aProfile = () =>
  scoresOf(oneOfEach(), oneOfEach(), oneOfEach(), oneOfEach());

/** The page as `Tabbed` gets it, with its container already in the document. */
const aGlobalStatsPage = () => {
  const loaded = load();
  const page = loaded.GlobalStats(aProfile());
  loaded.state.containers.set("#_chart", aVisibleContainer());
  page.component.initializer({ id: "_chart" });
  return { page, state: loaded.state };
};

test("the global chart is not drawn while its tab is still hidden", async () => {
  const { state } = aGlobalStatsPage();
  await settled();

  // Not even asked for: drawing here is drawing into a `display: none`
  // container, which is the zero-wide SVG this whole change is about.
  assert.equal(state.loads, 0);
  assert.equal(state.rendered.length, 0);
});

test("the global chart is drawn when its tab is shown", async () => {
  const { page, state } = aGlobalStatsPage();

  page.onShow();
  await settled();

  assert.equal(state.rendered.length, 1);
  // The tally it draws is the aggregate one, not a per-type slice.
  assert.deepEqual(
    [...state.rendered[0].options.series[0].data],
    new Array(11).fill(4)
  );
});

test("a second reveal does not stack a second chart", async () => {
  // `Tabbed` reports every click, including one on the tab already showing,
  // and ApexCharts appends a canvas rather than replacing one.
  const { page, state } = aGlobalStatsPage();

  page.onShow();
  page.onShow();
  page.onShow();
  await settled();

  assert.equal(state.loads, 1);
  assert.equal(state.rendered.length, 1);
});

test("the reveal draws into the container the initializer was given", async () => {
  const { page, state } = aGlobalStatsPage();

  page.onShow();
  await settled();

  assert.equal(state.rendered[0].element, state.containers.get("#_chart"));
});
