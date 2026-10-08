/**
 * @file `theme.js` decides the colour scheme before the first paint, from what
 * this browser stored. These run it in a vm with a stand-in for the three
 * things it touches — `localStorage`, `<html>`'s dataset and the window's
 * `storage` event — and nothing else, which is also a check that it touches
 * nothing else: it runs above the bundle, so `Utils`, `Dom` and the rest are
 * not there yet.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "theme.js"), "utf8");

const load = ({ stored, storage } = {}) => {
  const values = new Map(stored === undefined ? [] : [["memo-theme", stored]]);
  const listeners = {};
  const dataset = {};
  const context = vm.createContext({
    localStorage: storage ?? {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    document: { documentElement: { dataset } },
    window: {
      addEventListener: (type, listener) => (listeners[type] = listener),
    },
  });
  vm.runInContext(SOURCE, context);
  return { Theme: context.Theme, dataset, values, listeners };
};

test("nothing stored is System, and leaves the scheme to the stylesheet", () => {
  const { Theme, dataset } = load();
  assert.equal(Theme.read(), "system");
  assert.equal(dataset.theme, undefined);
});

test("a stored Light or Dark is on <html> before anything else runs", () => {
  assert.equal(load({ stored: "dark" }).dataset.theme, "dark");
  assert.equal(load({ stored: "light" }).dataset.theme, "light");
});

test("a value it does not know is System rather than a scheme", () => {
  // Hand-edited, or written by a later version that grew a fourth choice.
  const { Theme, dataset } = load({ stored: "sepia" });
  assert.equal(Theme.read(), "system");
  assert.equal(dataset.theme, undefined);
});

test("storage that throws draws the system's scheme rather than nothing", () => {
  const refusing = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("SecurityError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  const { Theme, dataset } = load({ storage: refusing });
  assert.equal(Theme.read(), "system");

  // Still applied for the page view in hand; it only fails to persist.
  assert.equal(Theme.choose("dark"), "dark");
  assert.equal(dataset.theme, "dark");
});

test("choose stores and applies, and System is stored as nothing", () => {
  const { Theme, dataset, values } = load();

  Theme.choose("dark");
  assert.equal(values.get("memo-theme"), "dark");
  assert.equal(dataset.theme, "dark");

  Theme.choose("system");
  assert.equal(values.has("memo-theme"), false);
  assert.equal(dataset.theme, undefined);
});

test("a choice made in another tab is applied in this one", () => {
  const { dataset, values, listeners } = load();
  values.set("memo-theme", "dark");
  listeners.storage({ key: "memo-theme" });
  assert.equal(dataset.theme, "dark");

  // `key: null` is `localStorage.clear()`, which is System again.
  values.clear();
  listeners.storage({ key: null });
  assert.equal(dataset.theme, undefined);
});

test("the three choices are offered in the order the issue names them", () => {
  const { Theme } = load();
  assert.deepEqual(
    [...Theme.CHOICES].map(({ value }) => value),
    ["system", "light", "dark"]
  );
});
