/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads list.js into a vm context with the
 * globals it expects and pulls the comparator, the page heading and the stats
 * line out of the script's scope.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const js = (...segments) =>
  fs.readFileSync(path.join(__dirname, ...segments), "utf8");

const source = js("list.js");

// `Utils` and `Icons` are the real thing, loaded the same way, because the
// heading's escaping and the `aria-hidden` on the glyph are part of what the
// markup below is being asked about, and a stand-in for either would be
// testing the stand-in. `initComponent` hands back the spec it was given, the
// way `components/home/index.test.js` does: that is what the real one does
// with it, minus the id, the style and the DOM.
//
// The rest are stubs. list.js destructures them at load time and assigns
// itself into `Components.List`, but every component that reads them stays
// undrawn here, so they only have to exist.
const context = vm.createContext({
  URL,
  console,
  Dom: {},
  Tables: {},
  TableView: {},
  Conversions: {},
  Components: {
    initComponent: (spec) => spec,
    UI: {},
    List: {},
  },
});

// `wrapInIife` in `asset_plan.js` wraps each bundled file in its own IIFE,
// which is what keeps two files' `const`s from colliding. Loading it the same
// way here keeps that difference visible.
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(js("..", "..", "utils", "general.js"), "undefined");
load(js("..", "..", "utils", "icons.js"), "undefined");

const { byEnglishTitle, ListPageHeader, toStats } = load(
  source,
  "({ byEnglishTitle, ListPageHeader, toStats })"
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

/**
 * The heading as it reaches the page. `content` is markup rather than a
 * string, so it is asked for one at the boundary `components/README.md`
 * describes.
 */
const heading = (title, username) =>
  String(ListPageHeader(title, username).content({ id: "x" }));

test("the profile link in the heading has an accessible name", () => {
  const rendered = heading("Films", "nil");

  // `icon` marks every glyph `aria-hidden`, and the anchor holds nothing but
  // the glyph — so the label is the whole of the link's name, and without it
  // the link computes none at all and is announced as "link" (#421).
  assert.ok(
    rendered.includes(`<a href="/profile/nil" aria-label="nil's profile">`)
  );
  assert.ok(rendered.includes('aria-hidden="true"'));
});

test("the heading's link has no text of its own to fall back on", () => {
  // Which is the reason the label above has to be there rather than a nicety:
  // an anchor wrapping one hidden glyph and no text node.
  const inside = /<a href="\/profile\/nil"[^>]*>(.*?)<\/a>/.exec(
    heading("Films", "nil")
  );

  assert.ok(inside);
  assert.equal(inside[1].replace(/<[^>]*>/g, "").trim(), "");
});

test("a username is escaped in the label as it is in the href", () => {
  // Two readings of one stored name that have to agree: `encodeURIComponent`
  // for the url, the tag function's escaping for the attribute.
  const rendered = heading("Films", `a"b'c`);

  // `encodeURIComponent` leaves an apostrophe alone, so the tag function is
  // what turns it into an entity in the href. The one in "'s profile" is the
  // template's own text and stays a literal, which an attribute delimited by
  // double quotes is entitled to hold.
  assert.ok(rendered.includes(`href="/profile/a%22b&#39;c"`));
  assert.ok(rendered.includes(`aria-label="a&quot;b&#39;c's profile"`));
});

///////////////////////////////////////////////////////////////////////////////
// The stats line under each sublist, and the one under the whole page.

/** An entry as `toStats` reads one: a status, a score, and a work. */
const rated = (score) => ({
  status: "Watched",
  score,
  commonMetadata: { duration: 120 },
});

/** What the line says about the mean, which is the last field on it. */
const meanOf = (entries) =>
  String(toStats(entries, "films")).match(/Mean score: (.*)$/)[1];

test("a section with nothing rated does not report a mean of zero", () => {
  // The bug, live in the "To watch" section of /films/nil: 210 entries, not
  // one of them scored, and `scores.length || 1` turned the sum of nothing
  // into `0.00`. On a 1-10 scale that is a plausible score rather than a
  // visible absence, which is what made it worse than the `NaN` next door.
  const toWatch = [{ status: "Planned" }, { status: "Planned" }];

  assert.equal(meanOf(toWatch), "-");
  assert.equal(meanOf([]), "-");
});

test("the empty mean does not take the rest of the line with it", () => {
  // `meanScore` is a formatted string now, so the template interpolates it
  // rather than calling `toFixed` on it. Every other field is still a
  // number, and a throw here would empty the whole stats line.
  const line = String(toStats([{ status: "Planned" }], "films"));

  assert.match(line, /^Total entries: 1 /);
  assert.match(line, /Days spent: 0\.00 /);
  assert.match(line, /Mean score: -$/);
});

test("a section with scores reports their mean to two places", () => {
  assert.equal(meanOf([rated(8), rated(6)]), "7.00");
  assert.equal(meanOf([rated(9)]), "9.00");
});

test("an unscored entry is left out of the mean, not counted as a zero", () => {
  assert.equal(meanOf([rated(8), { status: "Watched" }]), "8.00");
});

test("a score of zero is counted rather than dropped", () => {
  // Latent rather than live: `scoreParser` in `api/utils/parsers/entries.js`
  // refuses anything outside 1-10, and nothing stored carries a zero. Pinned
  // because `filter(e => e.score)` read as correct for as long as it did.
  assert.equal(meanOf([rated(0), rated(10)]), "5.00");
});
