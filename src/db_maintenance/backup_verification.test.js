const { test } = require("node:test");
const assert = require("node:assert/strict");

const { checkSnapshot, formatVerification } = require("./backup_verification");

const MANIFEST = {
  createdAt: "2026-08-26T07:27:44.541Z",
  database: "memo",
  collections: [
    { name: "books", file: "books.json", documents: 696, bytes: 12, sha256: "aaa" },
    { name: "users", file: "users.json", documents: 6, bytes: 3, sha256: "bbb" },
  ],
};

/** Every file exactly as the manifest describes it. */
const intact = {
  books: { present: true, sha256: "aaa", documents: 696 },
  users: { present: true, sha256: "bbb", documents: 6 },
};

test("a snapshot whose files match its manifest is ok", () => {
  const result = checkSnapshot({ manifest: MANIFEST, files: intact });

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.rows.map(({ name, checksum }) => [name, checksum]),
    [
      ["books", "ok"],
      ["users", "ok"],
    ]
  );
});

test("a file that no longer hashes to what the manifest recorded is a problem", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    // The same number of documents, so only the digest can tell: this is the
    // truncated-or-edited case the counts cannot see.
    files: { ...intact, books: { present: true, sha256: "ccc", documents: 696 } },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "books: books.json does not match its checksum",
  ]);
  assert.equal(result.rows[0].checksum, "differs");
});

test("a file the manifest lists and the snapshot doesn't have is a problem", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: { ...intact, users: { present: false } },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["users: users.json is missing"]);
  assert.equal(result.rows[1].checksum, "unknown");
});

test("a collection the caller never observed counts as missing", () => {
  const result = checkSnapshot({ manifest: MANIFEST, files: { books: intact.books } });

  assert.deepEqual(result.problems, ["users: users.json is missing"]);
});

test("a file holding a different number of documents than the manifest says is a problem", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: { ...intact, books: { present: true, sha256: "aaa", documents: 695 } },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "books: books.json holds 695 documents, manifest.json says 696",
  ]);
});

test("a file that could not be read is a problem, and only reported once", () => {
  // A truncated file fails to parse *and* fails its checksum. The table says
  // the digest differs, because that is the useful fact; the problem list
  // says it once.
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: {
      ...intact,
      books: { present: true, sha256: "ccc", error: "Unexpected end of JSON input" },
    },
  });

  assert.deepEqual(result.problems, [
    "books: books.json could not be read (Unexpected end of JSON input)",
  ]);
  assert.equal(result.rows[0].checksum, "differs");
});

test("a file that could not even be hashed says so", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: { ...intact, books: { present: true, error: "EBUSY: resource busy" } },
  });

  assert.deepEqual(result.problems, [
    "books: books.json could not be read (EBUSY: resource busy)",
  ]);
  assert.equal(result.rows[0].checksum, "unknown");
});

test("not parsing the files is the cheap path, not a disagreement", () => {
  // What backup_database.js observes when all it wants to know is whether the
  // bytes still hash the same: no document counts at all.
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: {
      books: { present: true, sha256: "aaa" },
      users: { present: true, sha256: "bbb" },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("a missing manifest is the whole answer", () => {
  const result = checkSnapshot({ manifest: undefined, files: intact });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["manifest.json is missing"]);
  assert.deepEqual(result.rows, []);
});

test("a manifest with no collections list is refused rather than passed", () => {
  const result = checkSnapshot({ manifest: { createdAt: "yesterday" } });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["manifest.json lists no collections"]);
});

test("live counts are drift, not damage", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: intact,
    live: { books: 700, users: 6 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.rows.map(({ liveDocuments, drift }) => [liveDocuments, drift]),
    [
      [700, 4],
      [6, 0],
    ]
  );
});

test("a collection the database has and the snapshot doesn't is a warning", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: intact,
    live: { books: 696, users: 6, gameEntries: 1091 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    "gameEntries is in the database but not in this snapshot",
  ]);
});

test("a file in the snapshot the manifest doesn't list is a warning", () => {
  const result = checkSnapshot({
    manifest: MANIFEST,
    files: intact,
    unlisted: ["films.json"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    "films.json is in the snapshot but not in manifest.json",
  ]);
});

test("without live counts the table has no live columns", () => {
  const lines = formatVerification(checkSnapshot({ manifest: MANIFEST, files: intact }));

  assert.deepEqual(lines, [
    "  collection   manifest   file   sha256",
    "  books             696    696   ok",
    "  users               6      6   ok",
    "",
    "manifest.json and the files agree on every collection " +
      "(2 collections, 702 documents).",
  ]);
});

test("with live counts the table shows what has moved since the snapshot", () => {
  const lines = formatVerification(
    checkSnapshot({ manifest: MANIFEST, files: intact, live: { books: 700, users: 6 } })
  );

  assert.deepEqual(lines, [
    "  collection   manifest   file   sha256   live now   drift",
    "  books             696    696   ok            700      +4",
    "  users               6      6   ok              6",
    "",
    "manifest.json and the files agree on every collection " +
      "(2 collections, 702 documents).",
  ]);
});

test("a broken snapshot's table says which file and why", () => {
  const lines = formatVerification(
    checkSnapshot({
      manifest: MANIFEST,
      files: { books: { present: false }, users: { present: true, sha256: "zzz", documents: 6 } },
      unlisted: ["notes.txt"],
    })
  );

  assert.deepEqual(lines, [
    "  collection   manifest   file   sha256",
    "  books             696      —   ?",
    "  users               6      6   DIFFERS",
    "",
    "2 problem(s) — this snapshot is not what the backup wrote:",
    "  books: books.json is missing",
    "  users: users.json does not match its checksum",
    "",
    "Worth knowing, not a failure:",
    "  notes.txt is in the snapshot but not in manifest.json",
  ]);
});
