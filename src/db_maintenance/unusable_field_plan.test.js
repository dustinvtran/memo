const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  NEVER_CLEARED,
  clearableFields,
  planUnusableFieldClearing,
} = require("./unusable_field_plan");

const byType = (type) => COLLECTIONS.find((c) => c.type === type);
const films = byType("films");
const books = byType("books");

/** A work with nothing wrong with it, so a test says what it is testing. */
const work = (id, fields = {}) => ({
  _id: id,
  entryType: "Book",
  englishTranslatedTitle: `Title ${id}`,
  apiRefs: [`ISBN__${id}`],
  externalUrls: [{ name: "google", url: "https://example.com" }],
  imageUrl: "https://example.com/cover.jpg",
  releaseYear: 1999,
  duration: 320,
  genres: ["Fiction"],
  authors: ["An Author"],
  publishers: ["A Publisher"],
  ...fields,
});

const idsFor = (plan, field) =>
  plan.unset.find((group) => group.field === field)?.ids ?? [];

test("a collection's clearable fields are externalUrls and its own two lists", () => {
  assert.deepEqual(clearableFields(books), [
    "externalUrls",
    "genres",
    "authors",
    "publishers",
    "releaseYear",
    "duration",
  ]);
  assert.deepEqual(clearableFields(films), [
    "externalUrls",
    "genres",
    "directors",
    "actors",
    "releaseYear",
    "duration",
  ]);
});

test("no collection can ever be planned to lose its apiRefs or entryType", () => {
  // The two fields the audit reports as corrupt that an unset is the wrong
  // answer for. Nothing is meant to be able to ask for them.
  for (const collection of COLLECTIONS) {
    for (const field of Object.keys(NEVER_CLEARED)) {
      assert.equal(clearableFields(collection).includes(field), false);
    }
  }
});

test("the 587 publishers written as an unawaited Promise are unset", () => {
  const plan = planUnusableFieldClearing(books, [
    work("b1", { publishers: {} }),
    work("b2", { publishers: {} }),
    work("b3"),
  ]);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(idsFor(plan, "publishers"), ["b1", "b2"]);
  assert.deepEqual(plan.totals, {
    works: 3,
    documents: 2,
    values: 2,
    partial: 0,
  });
});

test("an empty array wrapped in an array is unset, not read as one url", () => {
  // `[[]]` leaves `externalUrls[0].url` undefined, so the Title column falls
  // back to a Wikipedia search and nothing says why.
  const plan = planUnusableFieldClearing(films, [
    work("f1", { externalUrls: [[]] }),
  ]);

  assert.deepEqual(idsFor(plan, "externalUrls"), ["f1"]);
});

test("an array holding one empty string is unset", () => {
  // What the Director column renders as an empty clickable `<a>`.
  const plan = planUnusableFieldClearing(films, [
    work("f1", { directors: [""] }),
  ]);

  assert.deepEqual(idsFor(plan, "directors"), ["f1"]);
});

test("a number field holding something that is not a number is unset", () => {
  const plan = planUnusableFieldClearing(books, [
    work("b1", { duration: "320" }),
    work("b2", { releaseYear: Number.NaN }),
    work("b3", { duration: 0 }),
  ]);

  assert.deepEqual(idsFor(plan, "duration"), ["b1"]);
  assert.deepEqual(idsFor(plan, "releaseYear"), ["b2"]);
  // A stored 0 is a real number and a supported state — the column renders it
  // as `-` and backfill_game_playtimes.js treats it as no playtime. It is not
  // this script's business.
  assert.equal(plan.totals.values, 2);
});

test("a missing or empty value is left alone: there is nothing to unset", () => {
  // The whole point of the verb. These are what an unset *produces*, so
  // planning them again would be a script that never finishes.
  const plan = planUnusableFieldClearing(books, [
    work("b1", { publishers: undefined }),
    work("b2", { publishers: [] }),
    work("b3", { publishers: null }),
    work("b4", { duration: "" }),
  ]);

  assert.deepEqual(plan.unset, []);
  assert.equal(plan.totals.values, 0);
});

test("running the plan over its own result plans nothing", () => {
  const before = [work("b1", { publishers: {}, directors: [""] })];
  const plan = planUnusableFieldClearing(books, before);

  const after = before.map((document) => {
    const cleared = { ...document };
    for (const { field } of plan.documents[0].fields) delete cleared[field];
    return cleared;
  });

  assert.deepEqual(planUnusableFieldClearing(books, after).unset, []);
});

test("a value that still holds something usable is reported, not unset", () => {
  // Corrupt by the same predicate, but an unset would take the director with
  // it. Salvaging is a `$set`, which is a different decision than this one.
  const plan = planUnusableFieldClearing(films, [
    work("f1", { directors: ["", "Christopher Nolan"] }),
    work("f2", {
      externalUrls: [[], { name: "tmdb", url: "https://example.com" }],
    }),
  ]);

  assert.deepEqual(plan.unset, []);
  assert.equal(plan.totals.partial, 2);
  assert.equal(plan.totals.values, 0);
  assert.deepEqual(
    plan.partial.map(({ _id, field, kept }) => ({ _id, field, kept })),
    [
      { _id: "f1", field: "directors", kept: ["Christopher Nolan"] },
      {
        _id: "f2",
        field: "externalUrls",
        kept: [{ name: "tmdb", url: "https://example.com" }],
      },
    ]
  );
});

test("a document is spared field by field, not whole", () => {
  // Unlike the dead-field plan, one field it cannot account for is no reason
  // to leave a `{}` sitting in another: the fields are unrelated and each is
  // decided on its own.
  const plan = planUnusableFieldClearing(films, [
    work("f1", { directors: ["", "Christopher Nolan"], genres: {} }),
  ]);

  assert.deepEqual(idsFor(plan, "genres"), ["f1"]);
  assert.equal(plan.totals.partial, 1);
});

test("the ids of a field are collected into one group, in report order", () => {
  // What the script turns into one `updateMany` per field rather than a write
  // per document.
  const plan = planUnusableFieldClearing(books, [
    work("b1", { publishers: {}, genres: {} }),
    work("b2", { publishers: {} }),
    work("b3", { duration: "320" }),
  ]);

  assert.deepEqual(
    plan.unset.map((group) => group.field),
    ["genres", "publishers", "duration"]
  );
  assert.deepEqual(idsFor(plan, "publishers"), ["b1", "b2"]);
  assert.equal(plan.totals.documents, 3);
  assert.equal(plan.totals.values, 4);
});

test("a document reports which of its fields would go, and what is in them", () => {
  const plan = planUnusableFieldClearing(books, [
    work("b1", { publishers: {}, duration: "320" }),
  ]);

  assert.deepEqual(plan.documents, [
    {
      _id: "b1",
      title: "Title b1",
      fields: [
        { field: "publishers", value: {} },
        { field: "duration", value: "320" },
      ],
    },
  ]);
});

test("--fields restricts the run to the fields named", () => {
  const plan = planUnusableFieldClearing(
    books,
    [work("b1", { publishers: {}, genres: {} })],
    ["publishers"]
  );

  assert.deepEqual(idsFor(plan, "publishers"), ["b1"]);
  assert.deepEqual(idsFor(plan, "genres"), []);
  assert.equal(plan.totals.values, 1);
});

test("a field this collection does not have is simply not in its plan", () => {
  // `publishers` is a books and games field and means nothing to films, so a
  // run over all four is not an error. Rejecting a name no *selected*
  // collection knows is the caller's job.
  const plan = planUnusableFieldClearing(
    films,
    [work("f1", { directors: [""] })],
    ["publishers"]
  );

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.unset, []);
});

test("asking for apiRefs or entryType is refused outright", () => {
  for (const field of ["apiRefs", "entryType"]) {
    const plan = planUnusableFieldClearing(books, [work("b1")], [field]);
    assert.match(plan.blocked ?? "", new RegExp(`^${field} is never cleared`));
  }
});

test("a work with no apiRefs at all is not something this can help with", () => {
  // 24 tv and 4 books have none. The audit counts them as corrupt fields;
  // there is nothing to unset, and they belong on the cannot-be-refreshed
  // list instead.
  const plan = planUnusableFieldClearing(books, [
    { ...work("b1"), apiRefs: undefined },
  ]);

  assert.deepEqual(plan.unset, []);
  assert.equal(plan.totals.values, 0);
});

test("an entryType that disagrees with its collection is left for the backfill", () => {
  const plan = planUnusableFieldClearing(books, [
    work("b1", { entryType: "Film" }),
  ]);

  assert.deepEqual(plan.unset, []);
});

test("an empty collection plans nothing rather than refusing", () => {
  const plan = planUnusableFieldClearing(books, []);

  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.unset, []);
  assert.deepEqual(plan.totals, { works: 0, documents: 0, values: 0, partial: 0 });
});

test("anything that is not a list of works is refused", () => {
  for (const input of [undefined, null, "books", { _id: "b1" }]) {
    assert.equal(typeof planUnusableFieldClearing(books, input).blocked, "string");
  }
});

test("a descriptor that cannot say what a field is checked against is refused", () => {
  for (const collection of [undefined, {}, { stringArrayFields: ["genres"] }]) {
    assert.equal(
      typeof planUnusableFieldClearing(collection, [work("b1")]).blocked,
      "string"
    );
  }
});
