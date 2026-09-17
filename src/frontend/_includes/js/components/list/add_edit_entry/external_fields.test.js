/**
 * @file The override hint, which had never once rendered.
 *
 * `ExternalFields` decides, per field, whether what the form is about to show
 * is the user's value or the database's, and says so in red underneath. It
 * compared against `commonMetadata` — which `list.js` builds by folding the
 * overrides *over* the work — so it was comparing an override with itself, and
 * the answer was always "not overridden".
 *
 * The bug was invisible to every test that existed because it lived in the
 * choice of baseline rather than in the comparison, so these tests give the
 * component the two shapes the two call sites really hand it: a list row, with
 * `originalData` beside a folded `commonMetadata`, and an add-flow row with a
 * bare retrieved work and no `originalData` at all.
 *
 * The frontend scripts are plain globals concatenated into a bundle rather than
 * modules, so this loads the file into a vm context with stand-ins for the
 * component system and renders the markup to a string.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "external_fields.js"), "utf8");

/**
 * The component system, reduced to what this file uses: `initComponent` runs
 * `content` immediately and keeps the markup, and `include` concatenates the
 * markup of the children handed to it. Children are already rendered by the
 * time a parent includes them, because they are its arguments.
 */
const render = (row, type) => {
  // The same walk as `Utils.html`: each value goes *between* the fragments
  // either side of it. A `reduce` that appends the value after the fragment is
  // off by one, and puts every interpolation one slot late — which renders the
  // hint before the value it is about and empties the wrapper it belongs in.
  const interpolate = (value) =>
    Array.isArray(value) ? value.map(interpolate).join("") : String(value ?? "");
  const html = (strings, ...values) => {
    let markup = strings[0];
    for (let i = 0; i < values.length; i++) markup += interpolate(values[i]) + strings[i + 1];
    return markup;
  };

  const include = (children) => [children].flat().map((child) => child.content).join("");
  const initComponent = ({ content }) => ({ content: content({ id: "i", include }) });

  const context = vm.createContext({
    Utils: { html, css: html },
    Components: {
      initComponent,
      UI: {
        // Enough of a field to see which value the form would show.
        TextInput: ({ label, id, defaultValue }) =>
          initComponent({
            content: () => `<label>${label}</label><input id="${id}" value="${defaultValue ?? ""}">`,
          }),
      },
      List: {},
    },
    Array,
    String,
  });

  const ExternalFields = vm.runInContext(
    `${source}\n;Components.List.ExternalFields`,
    context
  );
  return ExternalFields(row, type).content;
};

/** The hints in the rendered markup, as `[field label, database value]`. */
const hints = (markup) =>
  [...markup.matchAll(/<label>([^<]*)<\/label><input id="([^"]*)"[^>]*>\s*<div class="override-hint">[^<]*<br>Database value: <strong>([^<]*)<\/strong>/g)]
    .map(([, , id, fromDb]) => [id, fromDb]);

/** A work as the API gives it. */
const theBear = {
  englishTranslatedTitle: "The Bear",
  originalTitle: "The Bear",
  releaseYear: 2022,
  genres: ["Drama", "Comedy"],
  actors: ["Jeremy Allen White"],
  episodes: 8,
};

/**
 * A row as `list.js` builds one: the untouched work under `originalData`, and
 * `commonMetadata` with the overrides folded in so the table can render one
 * value per column. That folding is what the old baseline was reading.
 */
const listRow = (overrides) => ({
  originalData: theBear,
  overrides,
  commonMetadata: {
    ...theBear,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== null)),
  },
});

test("a season's own title is marked, and names the work's title", () => {
  const markup = render(
    listRow({
      englishTranslatedTitle: "The Bear: Season 3",
      originalTitle: "The Bear: Season 3",
      releaseYear: 2024,
    }),
    "tv"
  );

  assert.deepEqual(hints(markup), [
    ["title", "The Bear"],
    ["original-title", "The Bear"],
    ["release-year", "2022"],
  ]);
});

/** The regression itself: the folded copy makes every field look untouched. */
test("the folded metadata is not the baseline", () => {
  const row = listRow({ englishTranslatedTitle: "The Bear: Season 3" });
  assert.equal(
    row.commonMetadata.englishTranslatedTitle,
    "The Bear: Season 3",
    "list.js folds the override in, so comparing against this compares it with itself"
  );
  assert.deepEqual(hints(render(row, "tv")), [["title", "The Bear"]]);
});

test("an entry that overrides nothing is marked nowhere", () => {
  assert.deepEqual(hints(render(listRow({}), "tv")), []);
});

test("the field still shows the user's value, not the database's", () => {
  const markup = render(listRow({ englishTranslatedTitle: "The Bear: Season 3" }), "tv");
  assert.match(markup, /<input id="title" value="The Bear: Season 3">/);
});

test("a list override is compared as the text the field shows", () => {
  const markup = render(listRow({ genres: ["Drama"] }), "tv");
  assert.deepEqual(hints(markup), [["genres", "Drama, Comedy"]]);
});

test("a list override identical to the work is not a difference", () => {
  assert.deepEqual(hints(render(listRow({ genres: ["Drama", "Comedy"] }), "tv")), []);
});

/**
 * An entry written before the databases had the work keeps its metadata in its
 * own overrides, and `list.js` sets `originalData` to `undefined` for it. There
 * is no work to disagree with, so nothing may be marked — falling back to
 * `commonMetadata` here would compare every override against itself and invent
 * a database value that does not exist. The `in` test is what prevents it.
 */
test("an entry with no work is marked nowhere, and reports no database value", () => {
  const overrides = { englishTranslatedTitle: "The Odyssey", releaseYear: 2026 };
  const row = { originalData: undefined, overrides, commonMetadata: { ...overrides } };

  assert.deepEqual(hints(render(row, "films")), []);
  assert.match(render(row, "films"), /<input id="title" value="The Odyssey">/);
});

/**
 * The add flow hands over `{ commonMetadata: work }` for a work it has just
 * retrieved, with no `originalData` key at all. Nothing overrides it yet, so
 * that *is* the untouched metadata and the fallback is right there.
 */
test("the add flow has no originalData and falls back to the retrieved work", () => {
  const markup = render({ commonMetadata: theBear }, "tv");

  assert.deepEqual(hints(markup), []);
  assert.match(markup, /<input id="title" value="The Bear">/);
});

test("a cleared override is a null, and names what it cleared", () => {
  // `null` means "the work's value is wrong and there is no replacement", so
  // the field is empty while the work still has something to report.
  const row = { originalData: theBear, overrides: { genres: null }, commonMetadata: theBear };
  assert.deepEqual(hints(render(row, "tv")), []);
  assert.match(render(row, "tv"), /<input id="genres" value="Drama, Comedy">/);
});

test("a game's duration is shown in hours and compared in them", () => {
  const work = { englishTranslatedTitle: "Nioh", duration: 480 };
  const row = {
    originalData: work,
    overrides: { duration: 600 },
    commonMetadata: { ...work, duration: 600 },
  };

  assert.deepEqual(hints(render(row, "games")), [["duration", "8"]]);
  assert.match(render(row, "games"), /<input id="duration" value="10">/);
});
