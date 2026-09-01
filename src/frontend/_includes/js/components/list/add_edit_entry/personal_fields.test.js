/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads personal_fields.js into a vm context with
 * the globals it expects and pulls `attachDatePickers` out of the script's
 * scope — the same trick as profile/profile_stats.test.js.
 *
 * What is under test is only the date pickers. Litepicker is fetched on demand
 * since #269, so attaching one is asynchronous, and the three things that can
 * go wrong in the gap between asking and arriving are what these cover: the
 * form being closed, the form being closed and opened again, and the script
 * never turning up at all.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "personal_fields.js"), "utf8");

/** An input, as far as anything under test here looks at one. */
const anInput = () => ({ isConnected: true });

/**
 * The script in a context of its own, with the document and the loader it
 * reaches for, and a record of what it did to them.
 *
 * The loader stub hands every caller the same promise, because the real one
 * does — `inFlight` in `utils/load_script.js` is what makes a second ask free,
 * and a stub that resolved each call separately would hide the case the third
 * test below is about. `loads` counts the asks anyway, since one script for
 * two fields is the point.
 */
const load = () => {
  const state = {
    loads: 0,
    load: undefined,
    resolveLoad: undefined,
    rejectLoad: undefined,
    constructed: [],
    errors: [],
    elements: new Map(),
  };

  const Litepicker = function ({ element }) {
    state.constructed.push(element);
  };

  // Stubs, not the real thing: nothing under test draws any markup. They exist
  // because the file destructures all of these at load time, and because its
  // last line writes itself onto `Components.List`.
  const context = vm.createContext({
    Utils: { html: () => "", css: () => "" },
    Dom: { el: () => {}, on: () => {}, show: () => {}, hide: () => {} },
    Components: { initComponent: () => {}, WithRemoteData: () => {}, List: {} },
    Tables: { statuses: [], filmStatuses: [] },
    Conversions: { statusToTitle: () => "" },
    ReviewTemplate: { initialReviewText: () => "" },
    LoadScript: {
      loadLitepicker: () => {
        state.loads += 1;
        state.load ??= new Promise((resolve, reject) => {
          state.resolveLoad = () => resolve(Litepicker);
          state.rejectLoad = (error) => reject(error);
        });
        return state.load;
      },
    },
    document: {
      getElementById: (id) => state.elements.get(id) ?? null,
    },
    console: { error: (message) => state.errors.push(message) },
  });

  const { attachDatePickers } = vm.runInContext(
    `(() => {\n${source}\n;return ({ attachDatePickers })\n})()`,
    context
  );

  return { attachDatePickers, state };
};

test("two date fields are one script and one picker each", async () => {
  const { attachDatePickers, state } = load();
  const started = anInput();
  const completed = anInput();
  state.elements.set("started-date", started);
  state.elements.set("completed-date", completed);

  const attaching = attachDatePickers(["started-date", "completed-date"]);
  // Awaited once for both, rather than once per field: two awaits would be two
  // asks, and the second would arrive after the first had already resolved.
  assert.equal(state.loads, 1);

  state.resolveLoad();
  await attaching;

  assert.equal(state.constructed.length, 2);
  assert.ok(state.constructed.includes(started));
  assert.ok(state.constructed.includes(completed));
});

test("a form with no date fields asks for nothing", async () => {
  const { attachDatePickers, state } = load();

  await attachDatePickers(["started-date", "completed-date"]);

  assert.equal(state.loads, 0);
  assert.equal(state.constructed.length, 0);
});

test("a films form gets the one picker it has a field for", async () => {
  const { attachDatePickers, state } = load();
  const completed = anInput();
  state.elements.set("completed-date", completed);

  const attaching = attachDatePickers(["started-date", "completed-date"]);
  state.resolveLoad();
  await attaching;

  assert.equal(state.constructed.length, 1);
  assert.equal(state.constructed[0], completed);
});

test("a form closed while the script loads gets no picker", async () => {
  const { attachDatePickers, state } = load();
  const started = anInput();
  state.elements.set("started-date", started);

  const attaching = attachDatePickers(["started-date"]);
  // The modal is dismissed: the input is still the one this call is holding,
  // and it is no longer in the document.
  started.isConnected = false;

  state.resolveLoad();
  await attaching;

  assert.equal(state.constructed.length, 0);
});

test("a form reopened while the script loads gets exactly one picker", async () => {
  const { attachDatePickers, state } = load();
  const first = anInput();
  state.elements.set("started-date", first);

  const opening = attachDatePickers(["started-date"]);

  // Closed and drawn again before the script arrived. `setContent` replaces the
  // markup, so the second form's input is a different element under the same
  // id — which is why the elements are looked up before the await and not
  // after. Looked up after, both calls would find this one and build two
  // pickers on it.
  first.isConnected = false;
  const second = anInput();
  state.elements.set("started-date", second);
  const reopening = attachDatePickers(["started-date"]);

  state.resolveLoad();
  await Promise.all([opening, reopening]);

  assert.equal(state.constructed.length, 1);
  assert.equal(state.constructed[0], second);
});

test("a script that never arrives leaves the fields alone and settles", async () => {
  const { attachDatePickers, state } = load();
  state.elements.set("started-date", anInput());
  state.elements.set("completed-date", anInput());

  const attaching = attachDatePickers(["started-date", "completed-date"]);
  state.rejectLoad(new Error("litepicker did not load"));
  // Resolves rather than rejecting: the caller is a component initializer that
  // does not await it, so a rejection here is an unhandled one, and the fields
  // are usable text inputs without a picker on them.
  await attaching;

  assert.equal(state.constructed.length, 0);
  assert.equal(state.errors.length, 1);
});
