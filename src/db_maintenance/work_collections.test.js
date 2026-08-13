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
