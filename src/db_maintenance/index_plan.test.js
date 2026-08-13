const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DESIRED_INDEXES,
  indexName,
  planIndexes,
  duplicateValues,
  uniqueIndexes,
} = require("./index_plan");

/** What `db.collection(name).indexes()` hands back, trimmed to what we read. */
const existing = (name, key, unique) => ({
  v: 2,
  name,
  key,
  ...(unique ? { unique: true } : {}),
});

const desired = (collection, key, options) => ({
  collection,
  key,
  ...(options ? { options } : {}),
  why: "a test",
});

test("an index is named the way MongoDB would name it", () => {
  assert.equal(indexName({ entryRef: 1 }), "entryRef_1");
  assert.equal(indexName({ userId: 1, updatedDate: -1 }), "userId_1_updatedDate_-1");
});

test("every desired index names a collection, a key and a reason", () => {
  for (const index of DESIRED_INDEXES) {
    assert.equal(typeof index.collection, "string");
    assert.ok(Object.keys(index.key).length > 0, `${index.collection} has an empty key`);
    assert.ok(index.why, `${indexName(index.key)} on ${index.collection} has no reason`);
  }
});

test("the list covers every field the issue names, and no field twice", () => {
  const names = DESIRED_INDEXES.map(
    (index) => `${index.collection}.${indexName(index.key)}`
  );

  assert.deepEqual([...new Set(names)].sort(), names.slice().sort());
  for (const expected of [
    "users.username_1",
    "users.userId_1",
    "filmEntries.userId_1",
    "tvShowEntries.userId_1",
    "gameEntries.userId_1",
    "bookEntries.userId_1",
    "filmEntries.workRef_1",
    "tvShowEntries.workRef_1",
    "gameEntries.workRef_1",
    "bookEntries.workRef_1",
    "filmReviews.entryRef_1",
    "tvShowReviews.entryRef_1",
    "gameReviews.entryRef_1",
    "bookReviews.entryRef_1",
    "entryRevisions.entryRef_1",
    "films.apiRefs_1",
    "tvShows.apiRefs_1",
    "games.apiRefs_1",
    "books.apiRefs_1",
  ]) {
    assert.ok(names.includes(expected), `${expected} is not in the list`);
  }
});

test("users.username is the only unique index, and it is unique", () => {
  assert.deepEqual(
    uniqueIndexes(DESIRED_INDEXES).map((index) => index.collection),
    ["users"]
  );
  assert.deepEqual(uniqueIndexes(DESIRED_INDEXES)[0].key, { username: 1 });
});

test("a database with no indexes needs every one of them created", () => {
  const plan = planIndexes(DESIRED_INDEXES, {});

  assert.equal(plan.create.length, DESIRED_INDEXES.length);
  assert.deepEqual(plan.satisfied, []);
  assert.deepEqual(plan.conflicting, []);
});

test("a collection missing from the report is a collection with no indexes", () => {
  // `indexes()` on a collection that doesn't exist yet throws rather than
  // returning [], so the script leaves it out entirely.
  const plan = planIndexes([desired("entryRevisions", { entryRef: 1 })], {});

  assert.equal(plan.create.length, 1);
});

test("re-running over the indexes it created is a no-op", () => {
  const plan = planIndexes(
    [
      desired("users", { username: 1 }, { unique: true }),
      desired("entryRevisions", { entryRef: 1 }),
    ],
    {
      users: [
        existing("_id_", { _id: 1 }),
        existing("username_1", { username: 1 }, true),
      ],
      entryRevisions: [
        existing("_id_", { _id: 1 }),
        existing("entryRef_1", { entryRef: 1 }),
      ],
    }
  );

  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.conflicting, []);
  assert.equal(plan.satisfied.length, 2);
});

test("the hand-made index the README asked for is recognised, not recreated", () => {
  const plan = planIndexes([desired("entryRevisions", { entryRef: 1 })], {
    entryRevisions: [existing("entryRef_1", { entryRef: 1 })],
  });

  assert.deepEqual(plan.create, []);
  assert.equal(plan.satisfied.length, 1);
});

test("a non-unique username index is a conflict, not something to create", () => {
  const plan = planIndexes([desired("users", { username: 1 }, { unique: true })], {
    users: [existing("username_1", { username: 1 })],
  });

  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.satisfied, []);
  assert.equal(plan.conflicting.length, 1);
  assert.match(plan.conflicting[0].reason, /no unique option/);
});

test("the same key under someone else's name is a conflict", () => {
  const plan = planIndexes([desired("entryRevisions", { entryRef: 1 })], {
    entryRevisions: [existing("by_entry", { entryRef: 1 })],
  });

  assert.equal(plan.conflicting.length, 1);
  assert.match(plan.conflicting[0].reason, /different name/);
});

test("our name over a different key is a conflict", () => {
  const plan = planIndexes([desired("users", { userId: 1 })], {
    users: [existing("userId_1", { userId: 1, username: 1 })],
  });

  assert.equal(plan.conflicting.length, 1);
  assert.match(plan.conflicting[0].reason, /different key/);
});

test("indexes on other collections don't satisfy this one", () => {
  const plan = planIndexes([desired("bookEntries", { userId: 1 })], {
    filmEntries: [existing("userId_1", { userId: 1 })],
  });

  assert.equal(plan.create.length, 1);
});

test("a field no two documents share has no duplicates", () => {
  const users = [
    { _id: "a", username: "nil" },
    { _id: "b", username: "tam" },
  ];

  assert.deepEqual(duplicateValues(users, "username"), []);
});

test("duplicates are reported with every document that holds one", () => {
  const users = [
    { _id: "a", username: "nil" },
    { _id: "b", username: "tam" },
    { _id: "c", username: "nil" },
    { _id: "d", username: "nil" },
  ];

  assert.deepEqual(duplicateValues(users, "username"), [
    { value: "nil", ids: ["a", "c", "d"] },
  ]);
});

test("two documents missing the field collide on it just as two equal ones do", () => {
  // MongoDB indexes a missing field as null, so a unique index fails to build
  // over these — reporting them as `null` is what stops that being a surprise.
  const users = [
    { _id: "a" },
    { _id: "b", username: null },
    { _id: "c", username: "nil" },
  ];

  assert.deepEqual(duplicateValues(users, "username"), [
    { value: null, ids: ["a", "b"] },
  ]);
});

test("values of different types are not conflated", () => {
  const documents = [{ _id: "a", ref: 1 }, { _id: "b", ref: "1" }];

  assert.deepEqual(duplicateValues(documents, "ref"), []);
});
