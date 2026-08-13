/**
 * @file The indexes the database is supposed to have, and the comparison that
 * decides which of them are missing. Pure and dependency-free, so it can be
 * unit tested without a database — see index_plan.test.js.
 *
 * The I/O lives in scripts/ensure_indexes.js.
 *
 * Every query the site makes goes through `_findOneByField` /
 * `_findAllByField` in ../api/utils/db/unsafe_functions.js, which is an
 * equality `$match` on one field. Each entry below names a field one of those
 * calls is given. Nothing here is a sort or a range, so every index is a
 * single ascending field, and `_id` is already indexed by MongoDB itself.
 *
 * The collection names come from ../api/utils/work_types.js, which is pure
 * too, so this file stays testable without an install.
 */

const { WORK_TYPES } = require("../api/utils/work_types");

/** The four of each, in the order the rest of the folder lists them. */
const ENTRY_COLLECTIONS = WORK_TYPES.map((workType) => workType.entries);
const REVIEW_COLLECTIONS = WORK_TYPES.map((workType) => workType.reviews);
const WORK_COLLECTIONS = WORK_TYPES.map((workType) => workType.works);

/**
 * @typedef {{
 *   collection: string,
 *   key: Record<string, 1 | -1>,
 *   options?: { unique?: boolean },
 *   why: string,
 * }} DesiredIndex
 *
 * `why` is printed by the dry run. An index nobody can name a query for is an
 * index to delete, so every one of these has to be able to say what it is for.
 * @type {DesiredIndex[]}
 */
const DESIRED_INDEXES = [
  {
    collection: "users",
    key: { username: 1 },
    // Unique closes the check-then-write race in the rename path: assignName
    // reads the name and writes it in two round trips, so two people claiming
    // one name at the same moment both pass the read. See #98 and name.js.
    options: { unique: true },
    why: "findIdOfName, getUserStats, getUserFromName, setOwnName — almost every request",
  },
  {
    collection: "users",
    key: { userId: 1 },
    why: "findOwnName, setBio, assignName",
  },
  ...ENTRY_COLLECTIONS.map((collection) => ({
    collection,
    key: { userId: 1 },
    why: "every list load, every profile load, /api/export, refreshStats",
  })),
  ...ENTRY_COLLECTIONS.map((collection) => ({
    collection,
    key: { workRef: 1 },
    why: "the local side of the $lookup in _findAllUserEntriesWithMetadata",
  })),
  ...REVIEW_COLLECTIONS.map((collection) => ({
    collection,
    key: { entryRef: 1 },
    why: "getReview on every expanded row, findReviews in the export",
  })),
  {
    collection: "entryRevisions",
    key: { entryRef: 1 },
    why: "every history read, every draft read, every save; findDraft runs on every autosave, once every 2.5s while an edit form is open",
  },
  // `apiRefs` is an array, so this is a **multikey** index — one index entry
  // per element. That is correct and is not something to "fix": findCachedWork
  // asks `{ apiRefs: "igdb__1234" }`, an equality match against one element,
  // which is exactly what multikey serves.
  ...WORK_COLLECTIONS.map((collection) => ({
    collection,
    key: { apiRefs: 1 },
    why: "findCachedWork, on every works/retrieve",
  })),
];

/**
 * MongoDB's own default name for a key, `field_1` joined with `_`. Naming
 * these explicitly rather than letting the server name them means a hand-made
 * `db.entryRevisions.createIndex({ entryRef: 1 })` — the thing the README used
 * to ask for — is recognised as the same index rather than collided with.
 * @type {(key: Record<string, number>) => string}
 */
const indexName = (key) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");

/**
 * The only option any index here sets. Comparing a normalised pair of these
 * rather than the whole option object keeps a server-supplied default (`v`,
 * `ns`) from reading as a difference.
 * @type {(options?: { unique?: boolean }) => { unique: boolean }}
 */
const comparableOptions = (options) => ({ unique: options?.unique === true });

const sameKey = (a, b) =>
  JSON.stringify(Object.entries(a ?? {})) ===
  JSON.stringify(Object.entries(b ?? {}));

const sameOptions = (a, b) =>
  JSON.stringify(comparableOptions(a)) === JSON.stringify(comparableOptions(b));

/**
 * Sorts each desired index into one of three buckets against what the database
 * already has. `createIndexes` is idempotent for an identical spec, so
 * `satisfied` is what makes a re-run a no-op.
 *
 * `conflicting` is the case that would otherwise surface as a driver error:
 * MongoDB refuses to build an index whose name or key collides with an
 * existing one that isn't identical — the same key under a different name, or
 * the same name with different options (a non-unique `username_1` where we
 * want a unique one). Neither can be fixed by creating anything, so they are
 * reported for a human to drop by hand rather than thrown.
 *
 * @typedef {{ name: string, key: Record<string, number>, unique?: boolean }} ExistingIndex
 * @typedef {{ create: DesiredIndex[], satisfied: DesiredIndex[], conflicting: (DesiredIndex & { existing: ExistingIndex, reason: string })[] }} IndexPlan
 * @type {(desired: DesiredIndex[], existingByCollection: Record<string, ExistingIndex[]>) => IndexPlan}
 */
const planIndexes = (desired, existingByCollection) => {
  const plan = { create: [], satisfied: [], conflicting: [] };

  for (const index of desired) {
    const name = indexName(index.key);
    const existing = existingByCollection[index.collection] ?? [];

    const byName = existing.find((e) => e.name === name);
    const byKey = existing.find((e) => sameKey(e.key, index.key));
    const match = byName ?? byKey;

    if (!match) {
      plan.create.push(index);
    } else if (
      match.name === name &&
      sameKey(match.key, index.key) &&
      sameOptions(match, index.options)
    ) {
      plan.satisfied.push(index);
    } else {
      plan.conflicting.push({ ...index, existing: match, reason: reasonFor(index, match, name) });
    }
  }

  return plan;
};

/**
 * Groups documents by the value of `field`, keeping only the values more than
 * one document carries. A unique index cannot be built over one of these, so
 * this is what the script checks before asking for one.
 *
 * A missing field is grouped under `null`, because that is how MongoDB indexes
 * it: two users with no username at all collide on a unique index exactly as
 * two users named "nil" do.
 *
 * @type {(documents: object[], field: string) => { value: unknown, ids: unknown[] }[]}
 */
const duplicateValues = (documents, field) => {
  const groups = new Map();
  for (const document of documents) {
    const raw = document?.[field];
    const value = raw === undefined ? null : raw;
    const key = JSON.stringify(value);
    if (!groups.has(key)) groups.set(key, { value, ids: [] });
    groups.get(key).ids.push(document?._id);
  }
  return [...groups.values()].filter(({ ids }) => ids.length > 1);
};

/** The indexes whose creation a duplicate check has to clear first. */
/** @type {(desired: DesiredIndex[]) => DesiredIndex[]} */
const uniqueIndexes = (desired) =>
  desired.filter(({ options }) => options?.unique === true);

module.exports = {
  ENTRY_COLLECTIONS,
  REVIEW_COLLECTIONS,
  WORK_COLLECTIONS,
  DESIRED_INDEXES,
  indexName,
  planIndexes,
  duplicateValues,
  uniqueIndexes,
};

///////////////////////////////////////////////////////////////////////////////

const reasonFor = (index, match, name) => {
  if (match.name !== name) {
    return `${match.name} already indexes the same key under a different name`;
  }
  if (!sameKey(match.key, index.key)) {
    return `${name} exists over a different key, ${JSON.stringify(match.key)}`;
  }
  return (
    `${name} exists with ${match.unique === true ? "" : "no "}unique option, ` +
    `but ${index.options?.unique === true ? "" : "no "}unique is wanted`
  );
};
