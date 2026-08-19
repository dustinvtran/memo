const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ENTRY_COLLECTIONS,
  DESIRED_INDEXES,
  indexName,
  planIndexes,
  duplicateValues,
  uniqueIndexes,
} = require("./index_plan");
const { toUserEntriesPipeline } = require("../api/utils/db/queries");

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
  // Underscores double up around `_id`, because the field is already one.
  assert.equal(
    indexName({ userId: 1, updatedDate: -1, _id: 1 }),
    "userId_1_updatedDate_-1__id_1"
  );
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
    "filmEntries.userId_1_updatedDate_-1__id_1",
    "tvShowEntries.userId_1_updatedDate_-1__id_1",
    "gameEntries.userId_1_updatedDate_-1__id_1",
    "bookEntries.userId_1_updatedDate_-1__id_1",
    "filmEntries.workRef_1",
    "tvShowEntries.workRef_1",
    "gameEntries.workRef_1",
    "bookEntries.workRef_1",
    "filmReviews.entryRef_1",
    "tvShowReviews.entryRef_1",
    "gameReviews.entryRef_1",
    "bookReviews.entryRef_1",
    "entryRevisions.entryRef_1",
    "entryRevisions.entryRef_1_kind_1_userId_1",
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

test("the entry list's sort is served by a compound index, not performed", () => {
  // The index has to answer the whole of `toUserEntriesPipeline`: `userId`
  // first, for the equality match, then the sort's fields in the sort's own
  // order and directions. Anything less and the planner puts a blocking sort
  // back in front of the `$limit` — which is what the single-field `userId`
  // index on its own leaves it doing. Reading the pipeline rather than
  // restating it is what keeps the two from drifting apart.
  const [{ $match }, { $sort }] = toUserEntriesPipeline({
    userId: "u1",
    workCollection: "films",
  });
  const wanted = {
    ...Object.fromEntries(Object.keys($match).map((field) => [field, 1])),
    ...$sort,
  };

  assert.deepEqual(wanted, { userId: 1, updatedDate: -1, _id: 1 });

  for (const collection of ENTRY_COLLECTIONS) {
    const keys = DESIRED_INDEXES.filter(
      (index) => index.collection === collection
    ).map((index) => JSON.stringify(index.key));

    assert.ok(
      keys.includes(JSON.stringify(wanted)),
      `${collection} has no index matching ${JSON.stringify(wanted)}`
    );
  }
});

test("the plain userId index is still declared alongside the compound one", () => {
  // A compound index serves its own prefix, so this one answers nothing the
  // compound one cannot. It stays anyway: nothing in this folder drops an
  // index, so undeclaring it would leave it live and no longer explained. See
  // the comment on it in index_plan.js.
  for (const collection of ENTRY_COLLECTIONS) {
    const names = DESIRED_INDEXES.filter(
      (index) => index.collection === collection
    ).map((index) => indexName(index.key));

    assert.ok(names.includes("userId_1"), `${collection} lost its userId index`);
  }
});

test("the compound index is created beside the plain one, not in place of it", () => {
  // Same leading field, but a different key and a different name, so a database
  // that already has the single-field index — which is what the dry run of
  // #147 found — needs the compound one built and keeps both.
  const plan = planIndexes(
    [
      desired("filmEntries", { userId: 1 }),
      desired("filmEntries", { userId: 1, updatedDate: -1, _id: 1 }),
    ],
    {
      filmEntries: [
        existing("_id_", { _id: 1 }),
        existing("userId_1", { userId: 1 }),
      ],
    }
  );

  assert.deepEqual(plan.conflicting, []);
  assert.equal(plan.satisfied.length, 1);
  assert.deepEqual(
    plan.create.map((index) => indexName(index.key)),
    ["userId_1_updatedDate_-1__id_1"]
  );
});

test("findDraft's three fields are all in one index, in an order findRevisions can share", () => {
  // findDraft asks `{ entryRef, kind: 'draft', userId }` — the hottest read in
  // the collection — and findRevisions asks `{ entryRef, kind: 'revision' }`.
  // An index serves an equality match on a set of fields when they are a
  // prefix of the key, so `kind` has to come before `userId` for the second
  // query to be served by the first one's index.
  const keys = DESIRED_INDEXES.filter(
    (index) => index.collection === "entryRevisions"
  ).map((index) => index.key);

  const draft = keys.find(
    (key) => JSON.stringify(key) === JSON.stringify({ entryRef: 1, kind: 1, userId: 1 })
  );
  assert.ok(draft, "entryRevisions has no index over entryRef, kind and userId");

  const fields = Object.keys(draft);
  assert.deepEqual(fields.slice(0, 2), ["entryRef", "kind"]);
  assert.ok(
    Object.values(draft).every((direction) => direction === 1),
    "nothing here sorts on these, so every field is ascending"
  );
});

test("the plain entryRef index is still declared alongside the compound one", () => {
  // Same reason as the plain userId index above: the compound serves this
  // one's prefix, but undeclaring it would leave it live in the database and
  // no longer explained.
  const names = DESIRED_INDEXES.filter(
    (index) => index.collection === "entryRevisions"
  ).map((index) => indexName(index.key));

  assert.ok(names.includes("entryRef_1"));
});

test("the draft index is one to create against the database as #147 left it", () => {
  // The 23 indexes applied on 2026-08-18 include `entryRevisions.entryRef_1`
  // and nothing else on that collection, so the compound one is new work for
  // `ensure_indexes.js` rather than something it would consider satisfied.
  const plan = planIndexes(
    DESIRED_INDEXES.filter((index) => index.collection === "entryRevisions"),
    { entryRevisions: [existing("_id_", { _id: 1 }), existing("entryRef_1", { entryRef: 1 })] }
  );

  assert.deepEqual(plan.conflicting, []);
  assert.deepEqual(
    plan.create.map((index) => indexName(index.key)),
    ["entryRef_1_kind_1_userId_1"]
  );
  assert.equal(plan.satisfied.length, 1);
});

test("every workRef index says it has no query, rather than naming one it cannot serve", () => {
  // The $lookup these used to name joins `localField: 'workRef'` to
  // `foreignField: '_id'`, and a $lookup uses the index on the foreign side —
  // `works._id`. Nothing else filters on `workRef` either. They stay declared
  // because dropping an index is a human's call and undeclaring one only hides
  // it, so what the dry run prints has to be the honest version.
  const workRefIndexes = DESIRED_INDEXES.filter(
    (index) => JSON.stringify(index.key) === JSON.stringify({ workRef: 1 })
  );

  assert.deepEqual(
    workRefIndexes.map((index) => index.collection),
    ENTRY_COLLECTIONS
  );
  for (const index of workRefIndexes) {
    assert.doesNotMatch(index.why, /\$lookup in _findAllUserEntriesWithMetadata/);
    assert.match(index.why, /no query/);
  }
});

test("nothing in toUserEntriesPipeline's $lookup wants a local index", () => {
  // Reading the pipeline rather than restating it: if the join ever turns
  // around — `workRef` on the foreign side of a lookup from `works` — these
  // four indexes acquire a user and this test is the thing that fails.
  const stages = toUserEntriesPipeline({ userId: "u1", workCollection: "films" });
  const { $lookup } = stages.find((stage) => stage.$lookup);

  assert.equal($lookup.localField, "workRef");
  assert.equal($lookup.foreignField, "_id");
});
