/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads conversions.js into a vm context and
 * reads the `Conversions` global back off it — the same trick as
 * utils/columns.test.js.
 *
 * What is worth asserting here is not the spelling of any one title. It is
 * that there is one table: every list the frontend derives — the router's
 * membership test, the profile's order, a table's columns — has to come out of
 * `WORK_TYPES` covering exactly the same four types, because the failure #221
 * describes is one of them quietly covering three.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "conversions.js"), "utf8");

/**
 * Stands in for `js/utils/columns.js`, which is bundled *below* this file and
 * so does not exist while it loads. Every column builder answers with what it
 * was called, which is all the assertions below need and keeps this test off
 * the real column definitions.
 */
const columnsStub = () =>
  new Proxy(
    {},
    { get: (_, name) => (...args) => ({ column: name, args }) }
  );

/** Loads the file the way the bundle does: its own IIFE, globals crossing. */
const load = (globals) => {
  const context = vm.createContext(globals);
  vm.runInContext(`(() => {\n${source}\n})()`, context);
  return context.Conversions;
};

const Conversions = load({ Columns: columnsStub() });

const { WORK_TYPES, TYPES, isType, byType, byAPIType } = Conversions;
const { typeToTitle, typeToAPIType, apiTypeToType, statusToTitle } = Conversions;

test("the file loads without a Columns global, so the bundle order holds", () => {
  // `js/utils/columns.js` is bundled below this file, so `Columns` genuinely
  // is not there yet when this runs. The column lists may only reach for it
  // when they are called, which is what makes the backwards reference legal —
  // and this is the assertion that stops someone hoisting one to load time and
  // blanking every page on the site.
  assert.doesNotThrow(
    () => load({}),
    "conversions.js reads `Columns` while loading; it is bundled below this file"
  );
});

test("every derivation covers exactly the types in the table", () => {
  // Spread rather than compared as they are: these arrays were built inside
  // the vm context, so they carry its `Array.prototype` and `assert/strict`
  // counts that as a difference however identical the contents.
  const rows = [...WORK_TYPES];
  const types = rows.map((workType) => workType.type);

  assert.deepEqual([...TYPES], types, "TYPES is the table's types, in its order");
  assert.deepEqual(Object.keys(typeToTitle), types);
  assert.deepEqual(Object.keys(typeToAPIType), types);
  assert.deepEqual(
    Object.keys(apiTypeToType),
    rows.map((workType) => workType.apiType)
  );

  assert.ok(types.length > 0, "the table names no work types at all");
  assert.equal(new Set(types).size, types.length, "a type is named twice");
});

test("a type and its apiType convert back to each other", () => {
  // The pair is the frontend's half of #220: both sides get called `entryType`
  // depending on the file, so a round trip is the only cheap way to say which
  // direction a caller is going.
  TYPES.forEach((type) => {
    assert.equal(apiTypeToType[typeToAPIType[type]], type);
    assert.equal(byAPIType(typeToAPIType[type]).type, type);
  });
});

test("membership is a real test, not a lookup that Object.prototype answers", () => {
  // The regression this replaces: `components/list/index.js` asked
  // `typeToTitle[entryType]`, and `entryType` comes straight off the url.
  TYPES.forEach((type) => assert.equal(isType(type), true, `${type} is a type`));

  ["constructor", "toString", "__proto__", "hasOwnProperty", "films/", ""].forEach(
    (segment) => {
      assert.equal(isType(segment), false, `${segment} is not a work type`);
      assert.equal(byType(segment), undefined, `${segment} resolved to a row`);
    }
  );
});

test("a status reads as the type reads it", () => {
  assert.equal(statusToTitle("films", "InProgress"), "Watching");
  assert.equal(statusToTitle("games", "InProgress"), "Playing");
  assert.equal(statusToTitle("books", "Planned"), "To read");
  assert.equal(statusToTitle("tv", "Planned"), "To watch");
});

test("the two shared statuses answer even for a type nobody knows", () => {
  // Load bearing, and the reason `Completed` and `Dropped` are not in the
  // table: `utils/columns.js` calls this with `apiTypeToType[…]`, which is
  // undefined for an entry carrying an `entryType` the frontend has never
  // heard of. That row still has to be able to say what its status is.
  [undefined, "spaceships"].forEach((unknown) => {
    assert.equal(statusToTitle(unknown, "Completed"), "Completed");
    assert.equal(statusToTitle(unknown, "Dropped"), "Dropped");
    assert.equal(statusToTitle(unknown, "InProgress"), undefined);
  });

  assert.equal(statusToTitle("films", "Reticulating"), undefined);
});

test("every type builds a column list, and threads the status through", () => {
  TYPES.forEach((type) => {
    const columns = byType(type).columns("Completed");

    assert.ok(Array.isArray(columns) && columns.length > 0, `${type} has no columns`);

    // The status is not decoration: `score` and `playtime` render differently
    // for a planned entry than a completed one.
    const score = columns.find((column) => column.column === "score");
    assert.deepEqual(score.args, ["Completed"], `${type}'s score ignores the status`);
  });
});

test("each type's columns are its own", () => {
  // Four identical lists would mean the table had been filled in by copying,
  // which is the shape #221 is about.
  const shapes = TYPES.map((type) =>
    JSON.stringify(byType(type).columns("Completed").map(({ column }) => column))
  );

  assert.equal(new Set(shapes).size, shapes.length, "two types share a column list");
});
