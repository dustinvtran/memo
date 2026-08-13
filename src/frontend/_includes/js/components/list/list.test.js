/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads list.js into a vm context with the
 * globals it expects and pulls the comparator out of the script's scope.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "list.js"), "utf8");

// None of these is exercised: list.js destructures them at load time and
// assigns itself into `Components.List`, but every component that reads them
// stays unrendered here. So they only have to exist, and the two that are
// reached into have to be objects.
const context = vm.createContext({
  Utils: {},
  Tables: {},
  Conversions: {},
  Components: { UI: {}, List: {} },
});

// base.njk wraps each included file in its own IIFE, which is what keeps two
// files' `const`s from colliding. Loading it the same way here keeps that
// difference visible.
const { byEnglishTitle } = vm.runInContext(
  `(() => {\n${source}\n;return ({ byEnglishTitle })\n})()`,
  context
);

/** An entry as the sort sees it: overrides already merged into the metadata. */
const entry = (englishTranslatedTitle) => ({
  commonMetadata:
    englishTranslatedTitle === undefined ? {} : { englishTranslatedTitle },
});

const sorted = (...titles) =>
  titles
    .map(entry)
    .sort(byEnglishTitle)
    .map((e) => e.commonMetadata.englishTranslatedTitle);

test("a list comes out alphabetical rather than in the order it arrived", () => {
  // The order the entries endpoint returns is `updatedDate` descending, so
  // the input here is exactly what the old subtraction left untouched.
  assert.deepEqual(
    sorted("Perfect Blue", "Akira", "Blade Runner"),
    ["Akira", "Blade Runner", "Perfect Blue"]
  );
});

test("it compares as a reader would, not by code point", () => {
  // `'a' < 'B'` is false and `'É' < 'Z'` is false, so both of these come out
  // backwards from a naive `<`.
  assert.deepEqual(sorted("Blade Runner", "akira"), ["akira", "Blade Runner"]);
  assert.deepEqual(sorted("Zodiac", "Éclair"), ["Éclair", "Zodiac"]);
});

test("an entry whose work is missing its title sorts first, not off a cliff", () => {
  assert.deepEqual(sorted("Akira", undefined), [undefined, "Akira"]);
  assert.equal(byEnglishTitle({}, {}), 0);
  assert.equal(byEnglishTitle({}, entry("Akira")) < 0, true);
  assert.equal(byEnglishTitle(entry("Akira"), {}) > 0, true);
});

test("equal titles compare equal, so the sort stays stable across them", () => {
  assert.equal(byEnglishTitle(entry("Akira"), entry("Akira")), 0);
});
