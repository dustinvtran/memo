const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { COLLECTIONS } = require("./work_collections");

/**
 * The consumer is scripts/backfill_work_metadata.js, a directory below this
 * one, and it passes `adapterModule` straight to `require`. A relative
 * specifier resolves against the caller, so one stored relative to this file
 * pointed at src/db_maintenance/api/... from there — every collection skipped,
 * every run reporting success.
 */
test("every adapterModule is an absolute path to a file that exists", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(
      path.isAbsolute(collection.adapterModule),
      `${collection.type}: ${collection.adapterModule} is not absolute, so it ` +
        `means different things to different callers`
    );
    assert.ok(
      fs.existsSync(collection.adapterModule),
      `${collection.type}: no adapter at ${collection.adapterModule}`
    );
  }
});

test("each collection names an adapter under its own type's folder", () => {
  const folders = {
    films: "films",
    tv: "tv_shows",
    games: "games",
    books: "books",
  };

  for (const collection of COLLECTIONS) {
    assert.equal(
      path.basename(path.dirname(collection.adapterModule)),
      folders[collection.type],
      `${collection.type} points at ${collection.adapterModule}`
    );
  }
});

/**
 * The script-only half is written here, the prefixes come from
 * ../api/utils/work_types.js, and only a retrieve by an identity prefix names
 * the work it claims to — an `hltb` id names a page, not a game.
 */
test("a retrievePrefix is always one of its type's identityPrefixes", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(
      collection.identityPrefixes.includes(collection.retrievePrefix),
      `${collection.type} retrieves by ${collection.retrievePrefix}, which is ` +
        `not in ${collection.identityPrefixes.join(", ")}`
    );
  }
});

test("every shared work type gets its script-only fields", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(
      collection.adapterModule && collection.retrievePrefix,
      `${collection.type} has no SCRIPT_FIELDS entry`
    );
  }
});

/**
 * What the consumer actually calls. `require.resolve` in the descriptors
 * proves a file is there; only requiring it proves the file holds an adapter.
 *
 * Two of the four used to end in `export default tmdbAdapter(…)`, and
 * `require` of an ES module hands back the namespace without unwrapping a
 * lone `default` — so from here films and tv were `{ __esModule, default }`,
 * `adapter.retrieve` was `undefined`, and the backfill died on the first work
 * it had anything to do while the two named-export adapters ran fine. #252.
 *
 * Needs the dependencies — the adapters import neverthrow, axios and the two
 * API clients — so it **skips itself** when they aren't installed, which is
 * how CI runs this suite without an install. It needs no credentials and no
 * network: every client here is built on first use, which is the property
 * that makes this testable at all.
 */
const DEPENDENCIES = [
  "neverthrow",
  "ramda",
  "ts-pattern",
  "axios",
  "node-themoviedb",
  "igdb-api-node",
];

const dependenciesInstalled = (() => {
  try {
    for (const dependency of DEPENDENCIES) require.resolve(dependency);
    return true;
  } catch (error) {
    return false;
  }
})();

const needsDependencies = {
  skip: dependenciesInstalled ? false : "run `npm install` to run these",
};

test("every adapterModule exports the search and retrieve the scripts call", needsDependencies, () => {
  for (const collection of COLLECTIONS) {
    const adapter = require(collection.adapterModule);

    for (const name of ["retrieve", "search"]) {
      assert.equal(
        typeof adapter[name],
        "function",
        `${collection.type}: ${collection.adapterModule} exports ` +
          `${Object.keys(adapter).join(", ")}, so adapter.${name} is ` +
          `${typeof adapter[name]}` +
          (typeof adapter.default?.[name] === "function"
            ? ` — it is at adapter.default.${name}, which is what a default ` +
              `export looks like from CommonJS; export it by name instead`
            : "")
      );
    }
  }
});
