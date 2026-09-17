/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads entry_form_io.js into a vm context with a
 * stand-in `document` backed by a plain id -> value map: enough of the DOM for
 * reading and writing form fields, which is all this module does.
 *
 * The map is also the point of the test. A form's fields depend on the entry
 * type — a film has no started date, a book no episode count — and the whole
 * of this module's behaviour is what it does about a field that is not there.
 * So `getElementById` answers `null` for anything the map does not name, the
 * way the real one does.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "entry_form_io.js"), "utf8");

/** @param {Record<string, string>} fields the ids this form has, and their values */
const formWith = (fields) => {
  const values = { ...fields };

  const document = {
    getElementById: (id) =>
      Object.prototype.hasOwnProperty.call(values, id)
        ? {
            get value() {
              return values[id];
            },
            set value(next) {
              values[id] = next;
            },
            // `writeForm` dispatches a real `change` on the status field, so
            // that the handler in `personal_fields.js` runs; here it only has
            // to not be missing.
            dispatchEvent: () => true,
          }
        : null,
  };

  const { readForm, writeForm, differencesFrom, takeFromWork } = vm.runInContext(
    `${source}\n;EntryFormIO`,
    vm.createContext({ document, Event: class {}, console })
  );

  return { values, readForm, writeForm, differencesFrom, takeFromWork };
};

const filmForm = (overrides) =>
  formWith({
    status: "Completed",
    score: "9",
    "completed-date": "2024-06-30",
    review: "A note.",
    title: "Stalker",
    "original-title": "",
    "release-year": "1979",
    duration: "162",
    "image-url": "",
    genres: "Sci-Fi, Drama",
    directors: "Andrei Tarkovsky",
    actors: "Alisa Freindlich",
    ...overrides,
  });

/**
 * The work `filmForm` above is showing, as the API gives it: no
 * `originalTitle` and no `imageUrl`, which the form shows as empty boxes.
 *
 * This is the baseline the overrides are read against, so a form built from
 * this work and submitted untouched must produce no overrides at all.
 */
const stalker = {
  englishTranslatedTitle: "Stalker",
  releaseYear: 1979,
  duration: 162,
  genres: ["Sci-Fi", "Drama"],
  directors: ["Andrei Tarkovsky"],
  actors: ["Alisa Freindlich"],
};

/** A list row as `list.js` builds one: the work, plus the work merged with `overrides`. */
const editing = (work, overrides = {}) => ({
  originalData: work,
  commonMetadata: { internalRef: "w1", ...work, ...overrides },
});

/** `[...]` because the object crosses a vm realm boundary on the way out. */
const keysOf = (obj) => [...Object.keys(obj)].sort();

test("the form is read back as an entry", () => {
  const { readForm } = filmForm();

  const entry = readForm({ commonMetadata: { internalRef: "w1" } }, "films");

  assert.equal(entry.workRef, "w1");
  assert.equal(entry.status, "Completed");
  assert.equal(entry.score, 9);
  assert.equal(entry.completedDate, Date.parse("2024-06-30"));
  assert.equal(entry.review, "A note.");
  // Films have no started date and no progress field.
  assert.equal("startedDate" in entry, false);
  assert.equal("progress" in entry, false);
});

test("an unrated score and an empty date read as null, not as NaN", () => {
  const { readForm } = filmForm({ score: "Unrated", "completed-date": "" });

  const entry = readForm({}, "films");

  assert.equal(entry.score, null);
  assert.equal(entry.completedDate, null);
});

test("editing an entry and changing nothing stores no overrides", () => {
  const { readForm } = filmForm();

  const entry = readForm(editing(stalker), "films");

  assert.deepEqual(keysOf(entry.overrides), []);
  assert.equal(entry.workRef, "w1");
});

test("adding an entry and changing nothing stores no overrides", () => {
  const { readForm } = filmForm();

  // The add path has no `originalData`: `search_results.js` hands the form
  // `{ commonMetadata: <the work just retrieved> }`, which nothing overrides
  // yet and is therefore the baseline itself.
  const entry = readForm(
    { commonMetadata: { internalRef: "w1", ...stalker } },
    "films"
  );

  assert.deepEqual(keysOf(entry.overrides), []);
  assert.equal(entry.workRef, "w1");
});

test("a field the user changed is stored as an override", () => {
  const { readForm } = filmForm({ title: "Сталкер", genres: "Sci-Fi" });

  const entry = readForm(editing(stalker), "films");

  assert.deepEqual(keysOf(entry.overrides), ["englishTranslatedTitle", "genres"]);
  assert.equal(entry.overrides.englishTranslatedTitle, "Сталкер");
  assert.deepEqual([...entry.overrides.genres], ["Sci-Fi"]);
});

test("a field the user emptied is stored as null", () => {
  const { readForm } = filmForm({ "release-year": "", directors: "" });

  const entry = readForm(editing(stalker), "films");

  // Not a copy of the work's value, and not absent: the work says 1979 and
  // the user says it doesn't. Both `list.js` and `export_view.js` read a null
  // override as "don't shadow the work", which is what a cleared field means.
  assert.deepEqual(keysOf(entry.overrides), ["directors", "releaseYear"]);
  assert.equal(entry.overrides.releaseYear, null);
  assert.equal(entry.overrides.directors, null);
});

test("emptying a field the work has nothing in stores nothing", () => {
  const { readForm } = filmForm({ "original-title": "", "image-url": "" });

  const entry = readForm(editing(stalker), "films");

  assert.deepEqual(keysOf(entry.overrides), []);
});

test("an override already on the entry survives a save that didn't touch it", () => {
  // The row's `commonMetadata` has the override folded in and the form is
  // showing it, so comparing against that would read the override as agreeing
  // with the work and drop it. `originalData` is the work underneath.
  const { readForm } = filmForm({ title: "Сталкер" });

  const entry = readForm(
    editing(stalker, { englishTranslatedTitle: "Сталкер" }),
    "films"
  );

  assert.equal(entry.overrides.englishTranslatedTitle, "Сталкер");
});

test("an entry whose work is gone keeps what the form holds", () => {
  // `list.js` sets `originalData` on every row, so an entry with no work has
  // the key holding `undefined` — and a `commonMetadata` built out of the
  // entry's own overrides. There is nothing to compare against, and the form
  // is the only copy of the metadata there is.
  const { readForm } = filmForm();

  const entry = readForm(
    {
      originalData: undefined,
      commonMetadata: { englishTranslatedTitle: "Stalker", releaseYear: 1979 },
    },
    "films"
  );

  assert.equal(entry.overrides.englishTranslatedTitle, "Stalker");
  assert.equal(entry.overrides.releaseYear, 1979);
});

test("a game's playtime is not an override just because it divided badly", () => {
  // 1975 minutes is 32.916666666666664 hours, and the field holds exactly
  // what `String(value / 60)` wrote into it.
  const { readForm } = formWith({
    status: "Completed",
    title: "Hades",
    "original-title": "",
    "release-year": "2020",
    duration: String(1975 / 60),
    "image-url": "",
    genres: "",
    platforms: "",
    studios: "",
    publishers: "",
  });

  const hades = {
    englishTranslatedTitle: "Hades",
    releaseYear: 2020,
    duration: 1975,
  };

  const entry = readForm(editing(hades), "games");

  assert.deepEqual(keysOf(entry.overrides), []);
});

test("a game's playtime the user did change is stored in minutes", () => {
  const { readForm } = formWith({ status: "Completed", duration: "40" });

  const entry = readForm(editing({ duration: 1975 }), "games");

  assert.equal(entry.overrides.duration, 2400);
});

test("a version is written back into the fields it belongs to", () => {
  const { values, writeForm } = filmForm();

  writeForm(
    {
      status: "Dropped",
      score: 4,
      completedDate: Date.parse("2023-01-02"),
      review: "The note as it was.",
    },
    "films",
    {}
  );

  assert.equal(values.status, "Dropped");
  assert.equal(values.score, "4");
  assert.equal(values["completed-date"], "2023-01-02");
  assert.equal(values.review, "The note as it was.");
});

test("a version with no score empties the score field", () => {
  const { values, writeForm } = filmForm();

  writeForm({ status: "Planned", score: null }, "films", {});

  assert.equal(values.score, "Unrated");
});

test("restoring an override puts the overridden value in the field", () => {
  const { values, writeForm } = filmForm();

  writeForm(
    { overrides: { englishTranslatedTitle: "Сталкер", genres: ["Sci-Fi"] } },
    "films",
    { originalData: { englishTranslatedTitle: "Stalker" } }
  );

  assert.equal(values.title, "Сталкер");
  assert.equal(values.genres, "Sci-Fi");
});

test("restoring a version that overrode nothing falls back to the cached metadata", () => {
  const { values, writeForm } = filmForm();

  writeForm({ overrides: {} }, "films", {
    // A list row's commonMetadata already has the *current* overrides folded
    // in, so the untouched API metadata is what a restore must fall back to.
    originalData: { englishTranslatedTitle: "Stalker", genres: ["Sci-Fi"] },
    commonMetadata: { englishTranslatedTitle: "A title typed later" },
  });

  assert.equal(values.title, "Stalker");
  assert.equal(values.genres, "Sci-Fi");
});

test("a game's duration is written back in the hours the form shows", () => {
  const { values, writeForm } = formWith({ status: "Completed", duration: "" });

  writeForm({ overrides: { duration: 600 } }, "games", {});

  assert.equal(values.duration, "10");
});

test("fields this entry type doesn't have are left alone", () => {
  const { values, writeForm } = filmForm();

  writeForm(
    { progress: 12, overrides: { episodes: 13, authors: ["Someone"] } },
    "films",
    {}
  );

  assert.equal("progress" in values, false);
  assert.equal("episodes" in values, false);
  assert.equal("authors" in values, false);
});

test("what a version is written into, the form reads back", () => {
  const { readForm, writeForm } = formWith({
    status: "Completed",
    score: "1",
    "started-date": "",
    "completed-date": "",
    progress: "",
    review: "",
    title: "",
    "original-title": "",
    "release-year": "",
    duration: "",
    "image-url": "",
    genres: "",
    directors: "",
    actors: "",
    episodes: "",
  });

  const version = {
    status: "InProgress",
    score: 7,
    startedDate: Date.parse("2024-01-05"),
    completedDate: null,
    progress: 6,
    review: "Halfway through.",
  };

  writeForm(version, "tv", {});
  const entry = readForm({}, "tv");

  assert.equal(entry.status, version.status);
  assert.equal(entry.score, version.score);
  assert.equal(entry.startedDate, version.startedDate);
  assert.equal(entry.completedDate, null);
  assert.equal(entry.progress, version.progress);
  assert.equal(entry.review, version.review);
});

/**
 * The link panel's half of this file: an entry with no work carries its
 * metadata in its own overrides, and attaching it to one means deciding which
 * side to believe, field by field. #343.
 *
 * `plainly` is not decoration. Everything the script returns is built inside
 * the vm context, so its arrays and objects have that realm's prototypes and
 * `deepStrictEqual` refuses them however identical the contents — `actual:
 * [ 'Scifi' ]`, `expected: [ 'Scifi' ]`, and a failing test.
 */
const plainly = (value) => JSON.parse(JSON.stringify(value));

test("a field the work agrees with is not a difference", () => {
  const { differencesFrom } = formWith({ title: "Dune", "release-year": "2021" });

  assert.deepEqual(
    plainly(differencesFrom({ englishTranslatedTitle: "Dune", releaseYear: 2021 }, "films")),
    []
  );
});

test("a field the work disagrees with carries both values", () => {
  const { differencesFrom } = formWith({ title: "Dune Part 2", "release-year": "2024" });

  assert.deepEqual(
    plainly(differencesFrom({ englishTranslatedTitle: "Dune: Part Two", releaseYear: 2024 }, "films")),
    [{ id: "title", key: "englishTranslatedTitle", label: "Title", mine: "Dune Part 2", theirs: "Dune: Part Two" }]
  );
});

/** The same rule the rest of the file follows: a field not on this form is not a field. */
test("a field this entry type does not have is never compared", () => {
  const { differencesFrom } = formWith({ title: "Dune" });

  const differences = differencesFrom(
    { englishTranslatedTitle: "Dune", episodes: 10, platforms: ["PC"] },
    "films"
  );
  assert.deepEqual(plainly(differences), []);
});

test("a list is compared as the text the form shows, not as an array", () => {
  const { differencesFrom } = formWith({ genres: "Sci-Fi, Drama" });

  assert.deepEqual(plainly(differencesFrom({ genres: ["Sci-Fi", "Drama"] }, "films")), []);
  assert.equal(differencesFrom({ genres: ["Sci-Fi"] }, "films").length, 1);
});

/**
 * The form shows a game's duration in hours and stores it in minutes. Comparing
 * the two unconverted reports every game as disagreeing about its own playtime.
 */
test("a game's duration is compared in the hours the form shows", () => {
  const { differencesFrom } = formWith({ duration: "8" });

  assert.deepEqual(plainly(differencesFrom({ duration: 480 }, "games")), []);
  assert.equal(differencesFrom({ duration: 480 }, "films").length, 1);
});

test("a value the work does not have shows as an empty one", () => {
  const { differencesFrom } = formWith({ "original-title": "Дюна" });

  assert.deepEqual(plainly(differencesFrom({}, "films")), [
    { id: "original-title", key: "originalTitle", label: "Original title", mine: "Дюна", theirs: "" },
  ]);
});

test("taking the work's value writes it into the named fields only", () => {
  const { values, takeFromWork } = formWith({
    title: "Dune Part 2",
    "release-year": "2023",
    genres: "Scifi",
  });

  takeFromWork(
    { englishTranslatedTitle: "Dune: Part Two", releaseYear: 2024, genres: ["Sci-Fi", "Drama"] },
    "films",
    ["title", "genres"]
  );

  assert.equal(values.title, "Dune: Part Two");
  assert.equal(values.genres, "Sci-Fi, Drama");
  assert.equal(values["release-year"], "2023", "not named, so not touched");
});

/**
 * The whole of "take the database's value": nothing deletes an override, the
 * field simply stops being one because it now holds what the work holds.
 */
test("a field taken from the work stops being an override when the form is read", () => {
  const { readForm, takeFromWork } = formWith({
    title: "Dune Part 2",
    genres: "Scifi",
    status: "Completed",
    "completed-date": "2024-03-01",
    score: "9",
    review: "",
  });
  const work = {
    internalRef: "w1",
    englishTranslatedTitle: "Dune: Part Two",
    genres: ["Sci-Fi"],
  };

  takeFromWork(work, "films", ["title"]);
  const entry = readForm({ commonMetadata: work, originalData: work }, "films");

  assert.equal(entry.workRef, "w1");
  assert.ok(!("englishTranslatedTitle" in entry.overrides), "taken from the work");
  assert.deepEqual(plainly(entry.overrides.genres), ["Scifi"], "kept, so an override");
});

test("a game's duration taken from the work survives the round trip", () => {
  const { readForm, takeFromWork } = formWith({
    duration: "3",
    status: "Completed",
    "completed-date": "2024-03-01",
    "started-date": "",
    score: "9",
    review: "",
  });
  const work = { internalRef: "w1", duration: 480 };

  takeFromWork(work, "games", ["duration"]);
  const entry = readForm({ commonMetadata: work, originalData: work }, "games");

  assert.ok(!("duration" in entry.overrides), "480 minutes shown as 8 hours and read back as 480");
});
