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
const anInput = () => ({ isConnected: true, addEventListener: () => {} });

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
  Litepicker.prototype.on = () => {};

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

/**
 * The completed date field's starting value, which had a Planned film carrying
 * today's date in a container nobody can see. `readForm` reads the value and
 * not the visibility, so every watchlist film submitted one — and once #359
 * started refusing that state, none of them could be saved at all.
 */
const completedDateValue = () => {
  const context = vm.createContext({
    Utils: { html: () => "", css: () => "" },
    Dom: { el: () => {}, on: () => {}, show: () => {}, hide: () => {} },
    Components: { initComponent: () => {}, WithRemoteData: () => {}, List: {} },
    Tables: { statuses: [], filmStatuses: [] },
    Conversions: { statusToTitle: () => "" },
    ReviewTemplate: { initialReviewText: () => "" },
    LoadScript: { loadLitepicker: () => new Promise(() => {}) },
    console,
    Date,
  });
  return vm.runInContext(`${source}
;Components.List.completedDateValue`, context);
};

/** The same local date `today()` in the file builds, not the UTC one. */
const todayString = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

test("a Planned film does not arrive carrying today's date", () => {
  assert.equal(completedDateValue()({ status: "Planned" }, "films"), "");
});

test("a film that has been watched still defaults to today", () => {
  assert.equal(completedDateValue()({ status: "Completed" }, "films"), todayString());
  assert.equal(completedDateValue()({ status: "Dropped" }, "films"), todayString());
});

/** The add flow has no status yet, and is the case the default was written for. */
test("a brand new film still defaults to today", () => {
  assert.equal(completedDateValue()({}, "films"), todayString());
  assert.equal(completedDateValue()(undefined, "films"), todayString());
});

test("only films default at all", () => {
  assert.equal(completedDateValue()({ status: "Completed" }, "games"), "");
  assert.equal(completedDateValue()({ status: "Planned" }, "tv"), "");
});

test("a date already on the entry wins over every default", () => {
  const stored = Date.parse("2024-03-01");
  assert.equal(completedDateValue()({ status: "Planned", completedDate: stored }, "films"), "2024-03-01");
});

/**
 * #544: a cleared date came back on the next click outside the field, and a
 * new game could not be saved as "To play" because of it.
 *
 * Two halves. Litepicker writes the date it last saw back into the field when
 * it closes, so it has to be told when the field is emptied (`syncPicker`).
 * And the date it kept writing back was today, put there by the form for
 * "Playing" — so when the status moves to one that may not carry a date, the
 * form takes back a date it filled in itself (`takeBackAutofill`), and leaves
 * one anybody else put there for the server to refuse out loud.
 */
const internals = () => {
  const elements = new Map();
  const shown = new Set();
  const context = vm.createContext({
    Utils: { html: () => "", css: () => "" },
    Dom: {
      el: (selector) => elements.get(selector.replace(/^#/, "")),
      on: () => {},
      show: (selector) => shown.add(selector),
      hide: (selector) => shown.delete(selector),
    },
    Components: { initComponent: () => {}, WithRemoteData: () => {}, List: {} },
    Tables: { statuses: [], filmStatuses: [] },
    Conversions: { statusToTitle: () => "" },
    ReviewTemplate: { initialReviewText: () => "" },
    LoadScript: { loadLitepicker: () => new Promise(() => {}) },
    document: { getElementById: (id) => elements.get(id) ?? null },
    Date,
  });
  const fns = vm.runInContext(
    `(() => {\n${source}\n;return ({ syncPicker, markAutofilled, fillToday, hideIfEmpty })\n})()`,
    context
  );
  const field = (id, value) => {
    const element = { value, dataset: {} };
    elements.set(id, element);
    return element;
  };
  return { ...fns, field, shown };
};

/** A picker holding `date`, recording what it was told. */
const aPicker = (date) => {
  const calls = [];
  let held = date;
  return {
    calls,
    getDate: () => held && { format: () => held },
    clearSelection: () => { calls.push(["clear"]); held = null; },
    setDate: (value) => { calls.push(["set", value]); held = value; },
  };
};

test("a field emptied while its picker holds a date empties the picker", () => {
  const { syncPicker } = internals();
  const picker = aPicker("2026-11-04");
  syncPicker(picker, "");
  assert.deepEqual(picker.calls.map((c) => [...c]), [["clear"]]);
  // Whitespace is as empty as nothing, to `readForm` too.
  const again = aPicker("2026-11-04");
  syncPicker(again, "   ");
  assert.equal(again.calls.length, 1);
});

test("a whole date typed into the field becomes the picker's date", () => {
  const { syncPicker } = internals();
  const picker = aPicker("2026-11-04");
  syncPicker(picker, "2025-01-31");
  assert.deepEqual(picker.calls.map((c) => [...c]), [["set", "2025-01-31"]]);
});

test("a half-typed date and an unchanged one tell the picker nothing", () => {
  const { syncPicker } = internals();
  const picker = aPicker("2026-11-04");
  syncPicker(picker, "2025-0");
  syncPicker(picker, "2026-11-04");
  assert.equal(picker.calls.length, 0);
  // Nor does an empty field over an empty picker.
  const empty = aPicker(null);
  syncPicker(empty, "");
  assert.equal(empty.calls.length, 0);
});

test("a date the form filled in is taken back when its field is hidden", () => {
  const { fillToday, hideIfEmpty, field, shown } = internals();
  const started = field("started-date", "");
  fillToday("started-date");
  assert.equal(started.value, todayString());

  hideIfEmpty("#started-date-container", "started-date");

  assert.equal(started.value, "");
  assert.equal(shown.has("#started-date-container"), false);
});

test("a date somebody changed is theirs, and stays on screen", () => {
  const { markAutofilled, hideIfEmpty, field, shown } = internals();
  const started = field("started-date", todayString());
  markAutofilled("started-date");
  // Picked from the calendar, typed, or restored from a draft: all of them
  // are a value the form did not put there.
  started.value = "2026-10-01";

  hideIfEmpty("#started-date-container", "started-date");

  assert.equal(started.value, "2026-10-01");
  assert.equal(shown.has("#started-date-container"), true);
});

test("a field never marked as a guess is left alone", () => {
  const { hideIfEmpty, field, shown } = internals();
  const started = field("started-date", todayString());

  hideIfEmpty("#started-date-container", "started-date");

  assert.equal(started.value, todayString());
  assert.equal(shown.has("#started-date-container"), true);
});
